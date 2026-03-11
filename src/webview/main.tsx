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
import { AppErrorBoundary } from './components/ErrorBoundary.js';
import { isPerfMode, PerfStore } from './perf/index.js';

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
  root.render(
    <AppErrorBoundary>
      <App transport={transport} transportKind={kind} />
    </AppErrorBoundary>,
  );

  if (isPerfMode) {
    PerfStore.init();
  }
}

// ============================================================================
// Dev Server: theme detection from system preference or URL param
// ============================================================================

if (kind === 'websocket') {
  const themeParam = new URLSearchParams(window.location.search).get('theme');
  if (themeParam === 'light') {
    document.body.dataset.vscodeThemeKind = 'vscode-light';
  } else if (themeParam === 'dark') {
    document.body.dataset.vscodeThemeKind = 'vscode-dark';
  }
  // Default: keep the HTML-set "vscode-dark". Use ?theme=light or the
  // TitleBar toggle (ThemeToggle) to switch at runtime.
}

// ============================================================================
// Browser Fork: read fork params from URL and simulate forkConfig message
// ============================================================================

const params = new URLSearchParams(window.location.search);
const forkFrom = params.get('forkFrom');
if (forkFrom) {
  // Simulate the forkConfig message that VS Code host would send.
  // Retry a few times to handle slow React mount — the listener
  // is idempotent (SET_FORK_MODE with same value is a no-op).
  const forkConfig = {
    kind: 'forkConfig',
    fromSessionId: forkFrom,
    atMessageId: params.get('forkAt') || undefined,
    initialPrompt: params.get('prompt') || undefined,
    model: params.get('model') || undefined,
    agencyMode: params.get('agency') || undefined,
    bypassEnabled: params.get('bypass') === '1',
    chromeEnabled: params.get('chrome') === '1',
  };
  const delays = [200, 600, 1500];
  for (const delay of delays) {
    setTimeout(() => window.postMessage(forkConfig, '*'), delay);
  }
}

// ============================================================================
// Browser Execute: read execute content from sessionStorage (set by opener tab)
// ============================================================================

const executeKey = params.get('execute');
if (executeKey) {
  const content = sessionStorage.getItem(executeKey);
  sessionStorage.removeItem(executeKey); // one-shot
  if (content) {
    const delays = [200, 600, 1500];
    for (const delay of delays) {
      setTimeout(() => window.postMessage({ kind: 'executeInCrispy', content }, '*'), delay);
    }
  }
}
