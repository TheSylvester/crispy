/**
 * Terminal Manager — PTY lifecycle for standalone/Tauri mode
 *
 * Owns all PTY instances. `client-connection.ts` routes RPCs here;
 * `dev-server.ts` calls `closeAllTerminals()` on shutdown. No business
 * logic — just spawn, pipe, resize, kill.
 *
 * @module terminal-manager
 */

import { accessSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { log } from '../core/log.js';

// node-pty is an optional dependency — dynamic import with graceful fallback.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pty = any;
let ptyModule: typeof import('@homebridge/node-pty-prebuilt-multiarch') | null = null;

async function loadPty(): Promise<typeof import('@homebridge/node-pty-prebuilt-multiarch')> {
  if (ptyModule) return ptyModule;
  try {
    ptyModule = await import('@homebridge/node-pty-prebuilt-multiarch');
    return ptyModule;
  } catch {
    throw new Error(
      'Terminal requires node-pty — run `npm install @homebridge/node-pty-prebuilt-multiarch`',
    );
  }
}

/** Resolve the default shell for the current platform. */
function resolveShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  if (process.env.SHELL) return process.env.SHELL;
  for (const sh of ['/usr/bin/zsh', '/bin/zsh', '/usr/bin/bash', '/bin/bash', '/bin/sh']) {
    try {
      accessSync(sh, constants.X_OK);
      return sh;
    } catch { /* next */ }
  }
  return 'sh';
}

// ============================================================================
// State
// ============================================================================

const terminals = new Map<string, Pty>();
const terminalDisposers = new Map<string, () => void>();

// ============================================================================
// Public API
// ============================================================================

export type SendEventFn = (event: {
  kind: 'event';
  sessionId: string;
  event: { type: 'terminal_data'; terminalId: string; data: string };
}) => void;

/** Wire an onData listener and store its disposer. */
function bindDataListener(id: string, p: Pty, sendEvent: SendEventFn): void {
  const disposer = p.onData((data: string) => {
    sendEvent({
      kind: 'event',
      sessionId: `terminal:${id}`,
      event: { type: 'terminal_data', terminalId: id, data },
    });
  });
  terminalDisposers.set(id, typeof disposer === 'function' ? disposer : disposer.dispose);
}

/** Spawn a new PTY and wire output to sendEvent. Returns the terminal ID. */
export async function createTerminal(
  opts: { cwd?: string; cols?: number; rows?: number },
  sendEvent: SendEventFn,
): Promise<{ terminalId: string }> {
  const pty = await loadPty();
  const id = randomUUID();
  const shell = resolveShell();

  const p = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 30,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, COLORTERM: 'truecolor' } as Record<string, string>,
  });

  terminals.set(id, p);
  bindDataListener(id, p, sendEvent);

  log({ source: 'terminal', level: 'info', summary: `Created terminal ${id.slice(0, 8)} (${shell})` });
  return { terminalId: id };
}

/** Write data to a terminal's PTY stdin. */
export function writeTerminal(id: string, data: string): void {
  terminals.get(id)?.write(data);
}

/** Resize a terminal's PTY. */
export function resizeTerminal(id: string, cols: number, rows: number): void {
  terminals.get(id)?.resize(cols, rows);
}

/** Detach output listener (client disconnected) — PTY stays alive for reconnect. */
export function detachTerminal(id: string): void {
  terminalDisposers.get(id)?.();
  terminalDisposers.delete(id);
}

/** Reattach a client to an existing PTY after reconnect. */
export function attachTerminal(id: string, sendEvent: SendEventFn): boolean {
  const p = terminals.get(id);
  if (!p) return false;
  detachTerminal(id);
  bindDataListener(id, p, sendEvent);
  return true;
}

/** Kill a terminal (explicit user close). */
export function closeTerminal(id: string): void {
  detachTerminal(id);
  terminals.get(id)?.kill();
  terminals.delete(id);
}

/** Return alive terminal IDs (for reconnect discovery). */
export function listTerminals(): string[] {
  return Array.from(terminals.keys());
}

/** Kill all terminals (server shutdown). */
export function closeAllTerminals(): void {
  for (const id of Array.from(terminals.keys())) {
    closeTerminal(id);
  }
}
