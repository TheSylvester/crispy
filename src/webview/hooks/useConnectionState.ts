/**
 * useConnectionState — Tracks WebSocket transport connection state
 *
 * Returns the current connection state for WebSocket transports.
 * Always returns 'connected' for VS Code transport (postMessage is always up).
 *
 * @module useConnectionState
 */

import { useState, useEffect } from 'react';
import { useEnvironment } from '../context/EnvironmentContext.js';
import { useTransport } from '../context/TransportContext.js';
import type { ConnectionState } from '../transport-websocket.js';

export function useConnectionState(): ConnectionState {
  const env = useEnvironment();
  const transport = useTransport();
  const [state, setState] = useState<ConnectionState>(() => {
    if (env === 'vscode') return 'connected';
    const t = transport as any;
    return typeof t.getConnectionState === 'function' ? t.getConnectionState() : 'connected';
  });

  useEffect(() => {
    if (env === 'vscode') return;
    const t = transport as any;
    if (typeof t.onConnectionStateChange !== 'function') return;
    return t.onConnectionStateChange((s: ConnectionState) => setState(s));
  }, [env, transport]);

  return state;
}
