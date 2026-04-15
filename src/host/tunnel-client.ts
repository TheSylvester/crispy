/**
 * Tunnel Client — Outbound WebSocket from local Crispy to relay server
 *
 * Receives resolved config from the core tunnel-config helper (settings-backed).
 * Connects to the relay and creates a ClientConnection to handle RPC traffic.
 * The relay forwards messages between this tunnel and remote browser clients.
 *
 * Runs alongside the local dev-server — both active simultaneously.
 * Local access is unaffected by tunnel state.
 *
 * @module tunnel-client
 */

import WebSocket from 'ws';
import { createClientConnection } from './client-connection.js';
import { getEnabledTunnelConfig, type HostType } from '../core/tunnel-config.js';

// --- Types ---

export interface RelayConfig {
  relayUrl: string;
  pairingToken: string;
  tunnelId: string;
  tunnelName: string;
}

export type TunnelStatus = 'connected' | 'reconnecting' | 'disconnected';

/** Detailed status with error reason for UI display. */
export interface TunnelStatusInfo {
  status: TunnelStatus;
  /** Set when disconnected — explains why. Drives wizard error states. */
  reason?: 'idle' | 'invalid-token' | 'relay-unreachable' | 'tunnel-in-use' | 'unlinked';
}

// --- State ---

let ws: WebSocket | null = null;
let status: TunnelStatus = 'disconnected';
let currentReason: TunnelStatusInfo['reason'] | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let disposed = false;
let currentConfig: RelayConfig | null = null;

const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];
const PING_INTERVAL_MS = 30_000;

const statusListeners = new Set<(status: TunnelStatus) => void>();
let broadcastStatus: ((info: TunnelStatusInfo) => void) | null = null;

// --- Public API ---

export function getTunnelStatus(): TunnelStatus {
  return status;
}

export function getTunnelStatusInfo(): TunnelStatusInfo {
  return { status, ...(currentReason && { reason: currentReason }) };
}

export function onTunnelStatusChange(handler: (status: TunnelStatus) => void): () => void {
  statusListeners.add(handler);
  return () => statusListeners.delete(handler);
}

export function setBroadcastStatus(fn: (info: TunnelStatusInfo) => void): void {
  broadcastStatus = fn;
}

export function getRelayConfig(): RelayConfig | null {
  return currentConfig;
}

/** Connect to relay. Called on daemon startup if config exists. */
export function connect(config: RelayConfig): void {
  disposed = false;
  currentConfig = config;
  reconnectAttempt = 0;
  doConnect(config);
}

/** Disconnect from relay and stop reconnecting. */
export function disconnect(): void {
  disposed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (ws) {
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'Client disconnect');
    }
    ws = null;
  }
  setStatus('disconnected', 'idle');
}

/** Auto-connect on startup using settings-backed config. */
export function autoConnect(hostType: HostType): void {
  const tunnel = getEnabledTunnelConfig(hostType);
  if (!tunnel) return;

  console.log(`[tunnel] Auto-connecting to relay: ${tunnel.relayUrl}`);
  connect({
    relayUrl: tunnel.relayUrl,
    pairingToken: tunnel.pairingToken,
    tunnelId: tunnel.tunnelId,
    tunnelName: tunnel.tunnelName,
  });
}

// --- Internal ---

function setStatus(newStatus: TunnelStatus, reason?: TunnelStatusInfo['reason']): void {
  // Compare both status AND reason — a reason change on the same status
  // (e.g. disconnected+idle -> disconnected+invalid-token) must still emit.
  if (status === newStatus && currentReason === reason) return;
  status = newStatus;
  currentReason = reason;
  const info: TunnelStatusInfo = { status: newStatus, ...(reason && { reason }) };
  broadcastStatus?.(info);
  for (const handler of statusListeners) {
    try { handler(newStatus); } catch { /* ignore listener errors */ }
  }
}

function doConnect(config: RelayConfig): void {
  if (disposed) return;

  const wsUrl = `${config.relayUrl}/tunnel?token=${encodeURIComponent(config.pairingToken)}`;
  setStatus('reconnecting');

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('[tunnel] Failed to create WebSocket:', err);
    setStatus('disconnected', 'relay-unreachable');
    scheduleReconnect(config);
    return;
  }

  let handlerDisposed = false;
  const handler = createClientConnection('tunnel-relay', (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });

  ws.on('open', () => {
    console.log(`[tunnel] Connected to relay (${config.tunnelName})`);
    setStatus('connected');
    reconnectAttempt = 0;

    // Start ping/pong keepalive
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data) => {
    handler.handleMessage(String(data)).catch((err) => {
      console.error('[tunnel] Handler error:', err);
    });
  });

  ws.on('close', (code, reason) => {
    console.log(`[tunnel] Disconnected (code=${code}, reason=${reason})`);
    cleanup();
    if (code === 4004) {
      // Relay says another tunnel is already active for this tunnelId.
      // Back off with long polling — the active tunnel may eventually die.
      console.log('[tunnel] Tunnel already connected from another process — will retry in 30s');
      setStatus('disconnected', 'tunnel-in-use');
      if (!disposed) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          doConnect(config);
        }, 30_000);
      }
      return;
    }
    if (code === 4001 || code === 4003) {
      // Auth rejection from relay
      setStatus('disconnected', 'invalid-token');
      // Don't auto-reconnect on auth failure — user must fix the token
      return;
    }
    if (!disposed) {
      setStatus('reconnecting', 'relay-unreachable');
      scheduleReconnect(config);
    }
  });

  ws.on('error', (err) => {
    console.error('[tunnel] WebSocket error:', err.message);
    // 'close' event always follows 'error' — cleanup happens there
  });

  function cleanup(): void {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    if (!handlerDisposed) {
      handlerDisposed = true;
      handler.dispose();
    }
    ws = null;
  }
}

function scheduleReconnect(config: RelayConfig): void {
  if (disposed) return;
  setStatus('reconnecting');
  const delay = BACKOFF_MS[Math.min(reconnectAttempt, BACKOFF_MS.length - 1)];
  reconnectAttempt++;
  console.log(`[tunnel] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doConnect(config);
  }, delay);
}
