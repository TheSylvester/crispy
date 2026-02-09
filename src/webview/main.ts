/**
 * Webview Entry Point — Environment detection + transport creation
 *
 * Detects whether running inside VS Code (acquireVsCodeApi exists) or
 * in a browser (Chrome dev mode) and creates the appropriate transport.
 *
 * @module main
 */

import type { Transport } from './transport.js';
import { createVSCodeTransport } from './transport-vscode.js';
import { createWebSocketTransport } from './transport-websocket.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

function detectTransport(): Transport {
  try {
    const api = acquireVsCodeApi();
    return createVSCodeTransport(api);
  } catch {
    // Not in VS Code — use WebSocket to dev server
    return createWebSocketTransport(`ws://${window.location.host}/ws`);
  }
}

// ============================================================================
// Bootstrap
// ============================================================================

const transport = detectTransport();

// Minimal UI placeholder — renders session list
async function init(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) return;

  root.textContent = 'Loading sessions...';

  try {
    const sessions = await transport.listSessions();

    if (sessions.length === 0) {
      root.textContent = 'No sessions found.';
      return;
    }

    root.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'session-list';

    for (const session of sessions) {
      const li = document.createElement('li');
      li.className = 'session-item';
      li.textContent = `${session.vendor} — ${session.sessionId.slice(0, 8)}… (${session.projectSlug})`;
      li.dataset.sessionId = session.sessionId;
      li.addEventListener('click', () => onSessionClick(session.sessionId));
      ul.appendChild(li);
    }

    root.appendChild(ul);
  } catch (err) {
    root.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function onSessionClick(sessionId: string): Promise<void> {
  const root = document.getElementById('root');
  if (!root) return;

  try {
    // Subscribe to live events
    transport.onEvent((sid, event) => {
      if (sid !== sessionId) return;
      console.log('[crispy]', event.type, event);
    });

    await transport.subscribe(sessionId);

    // Load transcript history
    const entries = await transport.loadSession(sessionId);
    root.innerHTML = `<h2>Session ${sessionId.slice(0, 8)}…</h2>
      <p>${entries.length} transcript entries loaded. Events streaming to console.</p>`;
  } catch (err) {
    root.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Run
init();
