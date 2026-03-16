/**
 * codex-rpc-client.ts
 *
 * JSON-RPC 2.0 transport over stdio for codex app-server.
 *
 * Responsibilities:
 * - Spawn and manage codex app-server child process
 * - NDJSON line parsing on stdout
 * - Request/response correlation with timeout
 * - Route server notifications and requests to callbacks
 *
 * Does NOT:
 * - Interpret message semantics (that's the adapter's job)
 * - Handle protocol handshake (adapter calls initialize)
 * - Manage session state
 */

import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { pushRosieLog } from '../../rosie/index.js';

// ============================================================================
// Types
// ============================================================================

export interface CodexRpcClientOptions {
  /** Command to spawn (default: 'codex') */
  command?: string;
  /** Arguments to pass to the command (default: ['app-server']) */
  args?: string[];
  /** Working directory for the process */
  cwd?: string;
  /** Environment variables to merge with process.env */
  env?: Record<string, string>;
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeoutMs?: number;
  /** Called when the server sends a notification (no id, has method) */
  onNotification: (method: string, params: unknown) => void;
  /** Called when the server sends a request (has both method and id) */
  onRequest: (method: string, id: number | string, params: unknown) => void;
  /** Called when an error occurs */
  onError: (error: Error) => void;
  /** Called when the process exits */
  onExit: (code: number | null, signal: string | null) => void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  method: string;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

// ============================================================================
// Implementation
// ============================================================================

export class CodexRpcClient {
  private readonly options: Required<
    Pick<CodexRpcClientOptions, 'command' | 'args' | 'requestTimeoutMs'>
  > &
    CodexRpcClientOptions;

  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private _alive = false;

  constructor(options: CodexRpcClientOptions) {
    this.options = {
      command: 'codex',
      args: ['app-server'],
      requestTimeoutMs: 30000,
      ...options,
    };
    this.spawn();
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request to the server and wait for a response.
   *
   * @param method - The RPC method name
   * @param params - Optional parameters for the method
   * @returns Promise resolving to the result, or rejecting with an error
   */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this._alive || !this.process?.stdin) {
      return Promise.reject(new Error('Process is not running'));
    }

    const id = this.nextRequestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    };

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, this.options.requestTimeoutMs);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
        method,
      });

      // Write to stdin
      const line = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error(`Failed to write to stdin: ${err.message}`));
        }
      });
    });
  }

  /**
   * Send a JSON-RPC response to a server request.
   *
   * @param id - The request ID from the server
   * @param result - The result to send back
   */
  sendResponse(id: number | string, result: unknown): void {
    if (!this._alive || !this.process?.stdin) {
      throw new Error('Process is not running');
    }

    const response = {
      jsonrpc: '2.0',
      id,
      result,
    };

    const line = JSON.stringify(response) + '\n';
    this.process.stdin.write(line, (err) => {
      if (err) {
        pushRosieLog({ level: 'error', source: 'codex-rpc-client', summary: `Failed to write response: ${err.message}` });
      }
    });
  }

  /**
   * Kill the child process.
   * Sends SIGTERM first, then SIGKILL after 3 seconds if still alive.
   *
   * Note: On Windows, both SIGTERM and SIGKILL map to TerminateProcess(),
   * which kills the process immediately. The escalation pattern is harmless
   * but provides no graceful shutdown window on Windows.
   */
  kill(): void {
    if (!this.process || !this._alive) return;

    // SIGTERM first
    this.process.kill('SIGTERM');

    // SIGKILL after 3 seconds if still running
    const killTimer = setTimeout(() => {
      if (this._alive && this.process) {
        this.process.kill('SIGKILL');
      }
    }, 3000);

    // Clear the timer if process exits normally
    this.process.once('exit', () => {
      clearTimeout(killTimer);
    });
  }

  /**
   * Whether the process is still running.
   */
  get alive(): boolean {
    return this._alive;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private spawn(): void {
    const { command, args, cwd, env } = this.options;

    // Merge env with process.env
    const mergedEnv = env ? { ...process.env, ...env } : process.env;

    const isWindows = process.platform === 'win32';
    this.process = spawn(command, args, {
      cwd,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(isWindows && { shell: true }),
    });

    this._alive = true;

    // Handle process errors
    this.process.on('error', (err) => {
      this._alive = false;
      this.rejectAllPending(new Error(`Process error: ${err.message}`));
      this.options.onError(err);
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      this._alive = false;
      const exitInfo =
        code !== null ? `exit code ${code}` : `signal ${signal}`;
      this.rejectAllPending(new Error(`Process exited: ${exitInfo}`));
      this.cleanup();
      this.options.onExit(code, signal);
    });

    // Handle stderr - log to console but don't crash
    if (this.process.stderr) {
      this.process.stderr.on('data', (data: Buffer) => {
        pushRosieLog({ level: 'debug', source: 'codex-rpc-client', summary: `stderr: ${data.toString().trim()}` });
      });
    }

    // Set up NDJSON parsing on stdout
    if (this.process.stdout) {
      this.readline = createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      });

      this.readline.on('line', (line) => {
        this.handleLine(line);
      });

      this.readline.on('error', (err) => {
        pushRosieLog({ level: 'error', source: 'codex-rpc-client', summary: `readline error: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
      });
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (err) {
      pushRosieLog({ level: 'error', source: 'codex-rpc-client', summary: 'Failed to parse JSON line', data: { line } });
      return;
    }

    if (typeof message !== 'object' || message === null) {
      pushRosieLog({ level: 'error', source: 'codex-rpc-client', summary: 'Invalid message (not object)', data: { line } });
      return;
    }

    const msg = message as Record<string, unknown>;

    // Classify the message:
    // 1. Response: has `id` field, has `result` or `error` (no `method`)
    // 2. Server request: has both `method` AND `id` at root level
    // 3. Notification: has `method`, no `id` at root level

    const hasId = 'id' in msg && msg.id !== undefined;
    const hasMethod = 'method' in msg && typeof msg.method === 'string';
    const hasResult = 'result' in msg;
    const hasError = 'error' in msg;

    if (hasId && !hasMethod && (hasResult || hasError)) {
      // Response to a client request
      this.handleResponse(msg as JsonRpcResponse);
    } else if (hasMethod && hasId) {
      // Server request (needs a response from client)
      this.handleServerRequest(msg as unknown as JsonRpcServerRequest);
    } else if (hasMethod && !hasId) {
      // Notification (no response needed)
      this.handleNotification(msg as unknown as JsonRpcNotification);
    } else {
      // Unknown message type - log but don't crash
      pushRosieLog({ level: 'error', source: 'codex-rpc-client', summary: 'Unknown message type', data: { line } });
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const { id, result, error } = response;
    if (id === undefined) return;

    const pending = this.pendingRequests.get(id);
    if (!pending) {
      // Response for unknown request - ignore
      return;
    }

    // Clear timeout and remove from pending
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingRequests.delete(id);

    // Resolve or reject
    if (error) {
      pending.reject(
        new Error(`RPC error (${error.code}): ${error.message}`),
      );
    } else {
      pending.resolve(result);
    }
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    const { method, id, params } = request;
    this.options.onRequest(method, id, params);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const { method, params } = notification;
    this.options.onNotification(method, params);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private cleanup(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
  }
}
