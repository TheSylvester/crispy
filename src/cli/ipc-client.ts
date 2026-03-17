/**
 * IPC Client — shared transport layer for CLI commands
 *
 * Extracted from crispy-dispatch.ts to share socket discovery and
 * message routing between dispatch modes and the rpc pipe.
 *
 * @module ipc-client
 */

import { connect, type Socket } from 'node:net';
import { sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { serversFilePath } from '../core/paths.js';

// ============================================================================
// Exit Codes
// ============================================================================

export const EXIT_OK = 0;
export const EXIT_APPROVAL = 10;
export const EXIT_TIMEOUT = 11;
export const EXIT_TRANSPORT = 12;
export const EXIT_USAGE = 13;

// ============================================================================
// Server Discovery
// ============================================================================

export interface ServerEntry {
  pid: number;
  socket: string;
  cwd: string;
  startedAt: string;
}

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function isWithinDir(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

export function discoverSocket(): string {
  if (process.env.CRISPY_SOCK) return process.env.CRISPY_SOCK;

  const serversFile = serversFilePath();
  let entries: ServerEntry[];
  try {
    entries = JSON.parse(readFileSync(serversFile, 'utf8'));
  } catch {
    throw new Error('No Crispy IPC servers found. Is VS Code/Cursor running with Crispy?');
  }

  entries = entries.filter(e => isPidAlive(e.pid));

  if (entries.length === 0) throw new Error('No Crispy IPC servers running.');
  if (entries.length === 1) return entries[0]!.socket;

  // Multiple servers — match by longest CWD prefix with path-boundary check
  const pwd = process.cwd();
  const sorted = entries
    .filter(e => isWithinDir(pwd, e.cwd))
    .sort((a, b) => b.cwd.length - a.cwd.length);

  if (sorted.length > 0) return sorted[0]!.socket;
  throw new Error(
    `Multiple Crispy servers running but none match CWD "${pwd}". Use CRISPY_SOCK to specify.\n` +
    `Active servers:\n${entries.map(e => `  PID ${e.pid}: ${e.cwd}`).join('\n')}`,
  );
}

// ============================================================================
// MessageRouter
// ============================================================================

let nextId = 1;

export interface RpcResponse {
  kind: 'response';
  id: string;
  result: unknown;
}

export interface RpcError {
  kind: 'error';
  id: string;
  error: string;
}

export interface RpcEvent {
  kind: 'event';
  sessionId: string;
  event: {
    type: string;
    [key: string]: unknown;
  };
}

export type RpcMessage = RpcResponse | RpcError | RpcEvent;

/**
 * Single socket reader that demuxes RPC responses from pushed events.
 * Events are buffered until a handler is registered, eliminating the
 * gap between sendRpc() and event streaming that caused Bug #1.
 */
export class MessageRouter {
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private eventHandler: ((evt: RpcEvent) => void) | null = null;
  private eventBuffer: RpcEvent[] = [];
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private closed = false;

  constructor(private conn: Socket) {
    conn.on('data', (chunk: Buffer) => this.onData(chunk));
    conn.on('close', () => {
      this.closed = true;
      this.rejectAll('Connection closed');
    });
    conn.on('error', (err: Error) => {
      this.closed = true;
      this.rejectAll(`Connection error: ${err.message}`);
    });
  }

  /** Install event handler. Flushes any buffered events immediately. */
  setEventHandler(handler: (evt: RpcEvent) => void): void {
    this.eventHandler = handler;
    for (const evt of this.eventBuffer) handler(evt);
    this.eventBuffer = [];
  }

  /** Send an RPC request and wait for the matching response. */
  sendRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Connection closed'));
    const id = String(nextId++);
    const msg = JSON.stringify({ kind: 'request', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.conn.write(msg + '\n');
    });
  }

  /** Send an RPC request without waiting for a response. */
  sendFireAndForget(method: string, params: Record<string, unknown>): void {
    if (this.closed) return;
    const id = String(nextId++);
    const msg = JSON.stringify({ kind: 'request', id, method, params });
    this.conn.write(msg + '\n');
  }

  end(): void {
    this.conn.end();
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: RpcMessage;
      try { parsed = JSON.parse(line); } catch { continue; }

      if (parsed.kind === 'response') {
        const resp = parsed as RpcResponse;
        const p = this.pending.get(resp.id);
        if (p) { this.pending.delete(resp.id); p.resolve(resp.result); }
      } else if (parsed.kind === 'error') {
        const err = parsed as RpcError;
        const p = this.pending.get(err.id);
        if (p) { this.pending.delete(err.id); p.reject(new Error(err.error)); }
      } else if (parsed.kind === 'event') {
        const evt = parsed as RpcEvent;
        if (this.eventHandler) {
          this.eventHandler(evt);
        } else {
          this.eventBuffer.push(evt);
        }
      }
    }
  }

  private rejectAll(reason: string): void {
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
  }
}
