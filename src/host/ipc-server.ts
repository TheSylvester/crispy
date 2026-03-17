/**
 * IPC Server — Unix Domain Socket / Windows Named Pipe
 *
 * Exposes the same JSON-RPC protocol as the WebSocket dev server and
 * VS Code postMessage bridge, but over a local IPC transport. Each
 * VS Code / Cursor window gets its own socket keyed by PID.
 *
 * Discovery: active servers are listed in ~/.crispy/ipc/servers.json
 * so the CLI can find the right one by CWD match.
 *
 * Security: filesystem permissions only — no tokens, no Origin checks.
 * Browsers cannot connect to Unix sockets, eliminating CSWSH entirely.
 *
 * @module ipc-server
 */

import { createServer, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { platform, userInfo } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createClientConnection } from './client-connection.js';
import { ipcDir, serversFilePath } from '../core/paths.js';

// ============================================================================
// Socket Path & Discovery
// ============================================================================

interface ServerEntry {
  pid: number;
  socket: string;
  cwd: string;
  startedAt: string;
}

export function getSocketPath(): string {
  if (process.env.CRISPY_SOCK) return process.env.CRISPY_SOCK;
  return platform() === 'win32'
    ? `\\\\.\\pipe\\crispy-${userInfo().username}-${process.pid}`
    : join(ipcDir(), `crispy-${process.pid}.sock`);
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Read servers.json, prune stale entries, clean up their socket files. */
function pruneAndRead(): ServerEntry[] {
  let entries: ServerEntry[] = [];
  try {
    entries = JSON.parse(readFileSync(serversFilePath(), 'utf8'));
  } catch { /* missing or corrupt — start fresh */ }

  const alive: ServerEntry[] = [];
  for (const entry of entries) {
    if (isPidAlive(entry.pid)) {
      alive.push(entry);
    } else {
      // Clean up stale socket file
      if (platform() !== 'win32') {
        try { unlinkSync(entry.socket); } catch { /* ENOENT is fine */ }
      }
    }
  }

  if (alive.length !== entries.length) {
    writeFileSync(serversFilePath(), JSON.stringify(alive, null, 2));
  }
  return alive;
}

/** Register this server in servers.json. */
function register(socketPath: string, cwd: string): void {
  const entries = pruneAndRead();
  entries.push({ pid: process.pid, socket: socketPath, cwd, startedAt: new Date().toISOString() });
  writeFileSync(serversFilePath(), JSON.stringify(entries, null, 2));
}

/** Remove this server from servers.json. */
function unregister(): void {
  try {
    const entries: ServerEntry[] = JSON.parse(readFileSync(serversFilePath(), 'utf8'));
    const filtered = entries.filter(e => e.pid !== process.pid);
    writeFileSync(serversFilePath(), JSON.stringify(filtered, null, 2));
  } catch { /* best effort */ }
}

// ============================================================================
// IPC Server
// ============================================================================

let connectionCounter = 0;

export async function startIpcServer(cwd: string): Promise<{ close(): void }> {
  const socketPath = getSocketPath();

  // Ensure IPC directory exists (use ipcDir() — on win32 socketPath is a pipe path, not a dir)
  mkdirSync(ipcDir(), { recursive: true });

  // Remove leftover socket from a previous crash of this same PID (unlikely but possible)
  if (platform() !== 'win32') {
    try { unlinkSync(socketPath); } catch { /* ENOENT is fine */ }
  }

  const server = createServer((conn: Socket) => {
    const clientId = `ipc-${++connectionCounter}`;
    let disposed = false;
    console.log(`[ipc] Client connected: ${clientId}`);

    const handler = createClientConnection(clientId, (msg) => {
      if (!conn.destroyed) {
        conn.write(JSON.stringify(msg) + '\n');
      }
    });

    function cleanup() {
      if (disposed) return;
      disposed = true;
      handler.dispose();
    }

    // StringDecoder handles multibyte UTF-8 characters split across
    // chunk boundaries (JSON.stringify CAN emit raw UTF-8 for non-ASCII).
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    conn.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          handler.handleMessage(line).catch(console.error);
        }
      }
    });

    conn.on('close', () => {
      // Flush any remaining partial data from the decoder
      const remaining = decoder.end();
      if (remaining) buffer += remaining;
      if (buffer.trim()) {
        handler.handleMessage(buffer).catch(console.error);
      }
      console.log(`[ipc] Client disconnected: ${clientId}`);
      cleanup();
    });
    conn.on('error', () => cleanup());
  });

  // Await successful bind before returning
  return new Promise((resolve, reject) => {
    const onStartupError = (err: Error) => reject(err);
    server.on('error', onStartupError);

    server.listen(socketPath, () => {
      // Replace startup error handler with permanent one
      server.removeListener('error', onStartupError);
      server.on('error', (err) => console.error('[ipc] Server error:', err));

      register(socketPath, cwd);
      console.log(`[ipc] Listening on ${socketPath}`);

      resolve({
        close() {
          server.close();
          unregister();
          if (platform() !== 'win32') {
            try { unlinkSync(socketPath); } catch { /* ENOENT is fine */ }
          }
        },
      });
    });
  });
}
