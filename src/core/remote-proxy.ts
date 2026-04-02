/**
 * Remote Proxy — merges sessions from remote Crispy daemons
 *
 * Connects to a remote daemon via WebSocket, periodically fetches its
 * session list, and exposes them for merging into listAllSessions().
 * When subscribing to a remote session, forwards the subscription and
 * all RPC calls through the WebSocket.
 *
 * Primary use case: Windows Tauri app proxying WSL daemon sessions.
 *
 * @module remote-proxy
 */

import { WebSocket } from 'ws';
import type { SessionInfo } from './agent-adapter.js';
import { log } from './log.js';

// ============================================================================
// Types
// ============================================================================

export interface RemoteSource {
  /** Display label, e.g. "WSL · Ubuntu" */
  label: string;
  /** WebSocket URL, e.g. "ws://localhost:3457" */
  url: string;
  /** Auth token for the remote daemon */
  token?: string;
}

interface RemoteConnection {
  source: RemoteSource;
  ws: WebSocket | null;
  sessions: SessionInfo[];
  connected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

// ============================================================================
// Registry
// ============================================================================

const remotes = new Map<string, RemoteConnection>();

/** Callbacks notified when remote session list changes. */
const changeListeners: Array<() => void> = [];

// ============================================================================
// RPC helpers
// ============================================================================

let rpcId = 1;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Per-connection pending RPC map. */
const pendingRpcs = new Map<string, Map<number, PendingRpc>>();

function sendRpc(label: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const conn = remotes.get(label);
  if (!conn?.ws || conn.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`Remote "${label}" not connected`));
  }

  const id = rpcId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = pendingRpcs.get(label);
      pending?.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 30_000);

    let pending = pendingRpcs.get(label);
    if (!pending) {
      pending = new Map();
      pendingRpcs.set(label, pending);
    }
    pending.set(id, { resolve, reject, timer });

    conn.ws!.send(JSON.stringify({ id, method, params }));
  });
}

// ============================================================================
// Connection management
// ============================================================================

function handleMessage(label: string, data: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }

  // RPC response
  if (typeof msg.id === 'number') {
    const pending = pendingRpcs.get(label);
    const rpc = pending?.get(msg.id);
    if (rpc) {
      clearTimeout(rpc.timer);
      pending!.delete(msg.id);
      if (msg.error) {
        rpc.reject(new Error(String((msg.error as Record<string, unknown>).message || msg.error)));
      } else {
        rpc.resolve(msg.result);
      }
    }
  }

  // Subscription events — forward to any active session channel subscribers
  // (handled by session-manager integration, not here)
}

function connectWs(label: string): void {
  const conn = remotes.get(label);
  if (!conn) return;

  const url = conn.source.token
    ? `${conn.source.url}?token=${conn.source.token}`
    : conn.source.url;

  const ws = new WebSocket(url);

  ws.on('open', () => {
    conn.connected = true;
    conn.ws = ws;
    log({ source: 'remote-proxy', level: 'info', summary: `Connected to remote "${label}" at ${conn.source.url}` });
    refreshRemoteSessions(label);
  });

  ws.on('message', (data) => {
    handleMessage(label, String(data));
  });

  ws.on('close', () => {
    conn.connected = false;
    conn.ws = null;
    log({ source: 'remote-proxy', level: 'info', summary: `Disconnected from remote "${label}"` });
    // Reconnect after 10s
    if (remotes.has(label)) {
      conn.reconnectTimer = setTimeout(() => connectWs(label), 10_000);
    }
  });

  ws.on('error', (err) => {
    log({ source: 'remote-proxy', level: 'warn', summary: `WebSocket error for "${label}": ${err.message}` });
    ws.close();
  });
}

async function refreshRemoteSessions(label: string): Promise<void> {
  try {
    const result = await sendRpc(label, 'listSessions') as SessionInfo[];
    const conn = remotes.get(label);
    if (!conn) return;

    // Tag sessions with environment label and deserialize dates
    conn.sessions = result.map(s => ({
      ...s,
      modifiedAt: new Date(s.modifiedAt),
      remoteEnvironment: conn.source.label,
    }));

    // Notify listeners
    for (const listener of changeListeners) {
      listener();
    }
  } catch (err) {
    log({ source: 'remote-proxy', level: 'warn', summary: `Failed to fetch sessions from "${label}": ${(err as Error).message}` });
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Connect to a remote Crispy daemon and start fetching its sessions.
 */
export function connectRemoteDaemon(source: RemoteSource): void {
  const existing = remotes.get(source.label);
  if (existing) {
    disconnectRemoteDaemon(source.label);
  }

  const conn: RemoteConnection = {
    source,
    ws: null,
    sessions: [],
    connected: false,
    reconnectTimer: null,
  };
  remotes.set(source.label, conn);
  connectWs(source.label);
}

/**
 * Disconnect from a remote daemon and remove its sessions.
 */
export function disconnectRemoteDaemon(label: string): void {
  const conn = remotes.get(label);
  if (!conn) return;

  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  if (conn.ws) conn.ws.close();

  // Clean up pending RPCs
  const pending = pendingRpcs.get(label);
  if (pending) {
    for (const rpc of pending.values()) {
      clearTimeout(rpc.timer);
      rpc.reject(new Error('Disconnected'));
    }
    pendingRpcs.delete(label);
  }

  remotes.delete(label);

  for (const listener of changeListeners) {
    listener();
  }
}

/**
 * Get all sessions from all connected remote daemons.
 */
export function getRemoteSessions(): SessionInfo[] {
  const all: SessionInfo[] = [];
  for (const conn of remotes.values()) {
    all.push(...conn.sessions);
  }
  return all;
}

/**
 * Check if a session ID belongs to a remote daemon.
 * Returns the remote label if found, null otherwise.
 */
export function getRemoteLabel(sessionId: string): string | null {
  for (const conn of remotes.values()) {
    if (conn.sessions.some(s => s.sessionId === sessionId)) {
      return conn.source.label;
    }
  }
  return null;
}

/**
 * Whether any remote sources are connected.
 */
export function hasRemoteSources(): boolean {
  return remotes.size > 0;
}

/**
 * Register a callback for remote session list changes.
 */
export function onRemoteSessionsChanged(callback: () => void): () => void {
  changeListeners.push(callback);
  return () => {
    const idx = changeListeners.indexOf(callback);
    if (idx >= 0) changeListeners.splice(idx, 1);
  };
}

/**
 * Refresh sessions from all connected remote daemons.
 */
export async function refreshAllRemoteSessions(): Promise<void> {
  await Promise.all(
    Array.from(remotes.keys()).map(label => refreshRemoteSessions(label))
  );
}

/**
 * Disconnect all remote daemons.
 */
export function disconnectAllRemoteDaemons(): void {
  for (const label of Array.from(remotes.keys())) {
    disconnectRemoteDaemon(label);
  }
}
