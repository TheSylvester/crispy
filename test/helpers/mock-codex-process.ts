/**
 * mock-codex-process.ts
 *
 * Mock codex app-server for testing CodexRpcClient.
 * Simulates stdin/stdout with NDJSON framing.
 *
 * Provides a ChildProcess-like interface that can be injected into
 * CodexRpcClient for testing without spawning a real process.
 */

import { PassThrough, Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';

/** JSON-RPC message types for testing */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

/**
 * Mock Codex process for testing RPC client.
 *
 * Usage:
 *   const mock = new MockCodexProcess();
 *   const client = new CodexRpcClient(mock.asChildProcess());
 *
 *   // Simulate server response
 *   mock.pushResponse(1, { result: 'ok' });
 *
 *   // Read what client sent
 *   const msg = await mock.getNextClientMessage();
 */
export class MockCodexProcess {
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;

  private stdinLines: string[] = [];
  private stdinBuffer = '';
  private pendingResolvers: Array<(msg: JsonRpcRequest) => void> = [];
  private emitter = new EventEmitter();
  private killed = false;

  constructor() {
    // Client writes to stdin (we read from it)
    const stdinStream = new PassThrough();
    this.stdin = stdinStream;

    // We push to stdout (client reads from it)
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    // Process stdin data - buffer and split on newlines
    stdinStream.on('data', (chunk: Buffer) => {
      this.stdinBuffer += chunk.toString();
      const lines = this.stdinBuffer.split('\n');
      // Keep the last (potentially incomplete) line in buffer
      this.stdinBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          this.stdinLines.push(line);
          this.processNextLine();
        }
      }
    });
  }

  private processNextLine(): void {
    while (this.pendingResolvers.length > 0 && this.stdinLines.length > 0) {
      const resolver = this.pendingResolvers.shift()!;
      const line = this.stdinLines.shift()!;
      try {
        const parsed = JSON.parse(line) as JsonRpcRequest;
        resolver(parsed);
      } catch {
        // If JSON parse fails, still resolve with partial data for error testing
        resolver({ jsonrpc: '2.0', id: -1, method: 'parse_error' });
      }
    }
  }

  /**
   * Push a successful response to stdout.
   */
  pushResponse(id: number | string, result: unknown): void {
    const response: JsonRpcResponse = { id, result };
    this.stdout.write(JSON.stringify(response) + '\n');
  }

  /**
   * Push an error response to stdout.
   */
  pushError(id: number | string, code: number, message: string, data?: unknown): void {
    const response: JsonRpcResponse = {
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    this.stdout.write(JSON.stringify(response) + '\n');
  }

  /**
   * Push a server notification (no id).
   */
  pushNotification(method: string, params: unknown): void {
    const notification: JsonRpcNotification = { method, params };
    this.stdout.write(JSON.stringify(notification) + '\n');
  }

  /**
   * Push a server request (has method + id).
   * The client is expected to respond to this.
   */
  pushServerRequest(method: string, id: number | string, params: unknown): void {
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    this.stdout.write(JSON.stringify(request) + '\n');
  }

  /**
   * Push raw data to stdout for testing partial/split JSON handling.
   */
  pushRaw(data: string): void {
    this.stdout.write(data);
  }

  /**
   * Read what client sent (next complete NDJSON line).
   */
  getNextClientMessage(): Promise<JsonRpcRequest> {
    return new Promise<JsonRpcRequest>((resolve) => {
      // If we already have a queued line, resolve immediately
      if (this.stdinLines.length > 0) {
        const line = this.stdinLines.shift()!;
        try {
          resolve(JSON.parse(line) as JsonRpcRequest);
        } catch {
          resolve({ jsonrpc: '2.0', id: -1, method: 'parse_error' });
        }
      } else {
        // Queue resolver for when data arrives
        this.pendingResolvers.push(resolve);
      }
    });
  }

  /**
   * Simulate process exit.
   */
  exit(code: number): void {
    this.killed = true;
    this.emitter.emit('exit', code, null);
    this.emitter.emit('close', code, null);
    this.stdout.end();
    this.stderr.end();
  }

  /**
   * Get ChildProcess-like interface for CodexRpcClient.
   */
  asChildProcess(): MockChildProcess {
    // Create a stable reference for chainable methods
    const childProcess: MockChildProcess = {
      stdin: this.stdin,
      stdout: this.stdout as Readable,
      stderr: this.stderr as Readable,
      pid: 12345,
      // Use getter to always return current state
      get killed() {
        return this.parent.killed;
      },
      parent: this, // Reference to access killed state
      kill: (): boolean => {
        if (!this.killed) {
          this.exit(0);
          return true;
        }
        return false;
      },
      on: (event: string, handler: (...args: unknown[]) => void): MockChildProcess => {
        this.emitter.on(event, handler);
        return childProcess;
      },
      once: (event: string, handler: (...args: unknown[]) => void): MockChildProcess => {
        this.emitter.once(event, handler);
        return childProcess;
      },
      removeListener: (event: string, handler: (...args: unknown[]) => void): MockChildProcess => {
        this.emitter.removeListener(event, handler);
        return childProcess;
      },
      removeAllListeners: (event?: string): MockChildProcess => {
        this.emitter.removeAllListeners(event);
        return childProcess;
      },
    } as MockChildProcess;

    return childProcess;
  }
}

/**
 * Minimal ChildProcess-like interface for testing.
 */
export interface MockChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number;
  readonly killed: boolean;
  kill: () => boolean;
  on: (event: string, handler: (...args: unknown[]) => void) => MockChildProcess;
  once: (event: string, handler: (...args: unknown[]) => void) => MockChildProcess;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => MockChildProcess;
  removeAllListeners: (event?: string) => MockChildProcess;
  /** Internal reference - not part of ChildProcess API */
  parent?: MockCodexProcess;
}
