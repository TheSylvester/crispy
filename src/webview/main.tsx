/**
 * Webview Entry Point — React 19
 *
 * Detects transport (VS Code postMessage or WebSocket) and renders the
 * React app. The transport is created once at startup as a module-level
 * singleton, then distributed via React context.
 *
 * @module main
 */

import { createRoot } from 'react-dom/client';
import type { Transport } from './transport.js';
import { createVSCodeTransport } from './transport-vscode.js';
import { createWebSocketTransport } from './transport-websocket.js';
import { App } from './App.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export type TransportKind = 'vscode' | 'websocket';

function detectTransport(): { transport: Transport; kind: TransportKind } {
  try {
    const api = acquireVsCodeApi();
    return { transport: createVSCodeTransport(api), kind: 'vscode' };
  } catch {
    // Not in VS Code — use WebSocket to dev server
    return { transport: createWebSocketTransport(`ws://${window.location.host}/ws`), kind: 'websocket' };
  }
}

// ============================================================================
// Bootstrap
// ============================================================================

const { transport, kind } = detectTransport();

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App transport={transport} transportKind={kind} />);
}
