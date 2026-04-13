/**
 * Tunnel Client — Outbound WebSocket from local Crispy to relay server
 *
 * Reads relay config from ~/.crispy/relay.json, connects to the relay,
 * and creates a ClientConnection to handle RPC traffic. The relay
 * forwards messages between this tunnel and remote browser clients.
 *
 * Runs alongside the local dev-server — both active simultaneously.
 * Local access is unaffected by tunnel state.
 *
 * @module tunnel-client
 */

import WebSocket from 'ws';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createClientConnection } from './client-connection.js';
import { relayConfigPath } from '../core/paths.js';

// --- Types ---

export interface RelayConfig {
  relayUrl: string;
  pairingToken: string;
  tunnelId: string;
  tunnelName: string;
}

export type TunnelStatus = 'connected' | 'reconnecting' | 'disconnected';

// --- State ---

let ws: WebSocket | null = null;
let status: TunnelStatus = 'disconnected';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let disposed = false;
let currentConfig: RelayConfig | null = null;

const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];
const PING_INTERVAL_MS = 30_000;

const statusListeners = new Set<(status: TunnelStatus) => void>();

// --- Public API ---

export function getTunnelStatus(): TunnelStatus {
  return status;
}

export function onTunnelStatusChange(handler: (status: TunnelStatus) => void): () => void {
  statusListeners.add(handler);
  return () => statusListeners.delete(handler);
}

export function getRelayConfig(): RelayConfig | null {
  return currentConfig;
}

/** Read relay config from disk. Returns null if file doesn't exist. */
export function readRelayConfig(): RelayConfig | null {
  const configPath = relayConfigPath();
  try {
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.relayUrl || !parsed.pairingToken || !parsed.tunnelId) return null;
    return parsed as RelayConfig;
  } catch {
    return null;
  }
}

/** Write relay config to disk and trigger tunnel connect. */
export function updateRelayConfig(config: RelayConfig): void {
  const configPath = relayConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  currentConfig = config;
  // Reconnect with new config
  disconnect();
  connect(config);
}

/** Clear relay config and disconnect tunnel. */
export function clearRelayConfig(): void {
  const configPath = relayConfigPath();
  try { unlinkSync(configPath); } catch { /* already gone */ }
  currentConfig = null;
  disconnect();
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
  setStatus('disconnected');
}

/** Auto-connect on startup if relay.json exists. */
export function autoConnect(): void {
  const config = readRelayConfig();
  if (config) {
    console.log(`[tunnel] Auto-connecting to relay: ${config.relayUrl}`);
    connect(config);
  }
}

// --- Internal ---

function setStatus(newStatus: TunnelStatus): void {
  if (status === newStatus) return;
  status = newStatus;
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
      setStatus('disconnected');
      if (!disposed) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          doConnect(config);
        }, 30_000);
      }
      return;
    }
    if (!disposed) {
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
