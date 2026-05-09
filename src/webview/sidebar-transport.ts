/**
 * Sidebar Transport — minimal RPC bridge for the Open Sessions sidebar webview.
 *
 * The sidebar consumes a tiny slice of the host's RPC surface — `listOpenSessions`
 * for the row data and a session-list change notification stream for live
 * refresh — so we hand-roll a small bridge instead of pulling the full
 * `SessionService` machinery (`transport-vscode.ts` + `client-connection.ts`).
 * Outbound clicks turn into a single `revealSession` postMessage that the host
 * routes to `openPanel`, which reveals the native VS Code editor panel for
 * that session (or creates a new one). FlexLayout is not involved.
 *
 * Wire shape:
 *   webview → host: { kind: 'request', id, method: 'listOpenSessions' | 'subscribeSessionList' | 'getGitBranchInfo' }
 *   host → webview: { kind: 'response', id, result } | { kind: 'error', id, error }
 *   host → webview: { kind: 'sessionListChanged' }   // pushed on every session-list event
 *   webview → host: { kind: 'revealSession', sessionId }
 *
 * @module sidebar-transport
 */

import type { OpenSessionInfo } from '../core/session-manager.js';

interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeAPI;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export interface SidebarTransport {
  listOpenSessions(): Promise<OpenSessionInfo[]>;
  getGitBranchInfo(cwd: string): Promise<{ branch: string; dirty: boolean } | null>;
  /** Register a handler for host-pushed session-list change notifications. */
  onSessionListChange(handler: () => void): () => void;
  /** Tell the host to reveal a session in an editor panel. Fire-and-forget. */
  revealSession(sessionId: string): void;
}

export function createSidebarTransport(): SidebarTransport {
  const api = acquireVsCodeApi();
  const pending = new Map<string, PendingRequest>();
  const handlers = new Set<() => void>();
  let counter = 0;

  function nextId(): string {
    return `sb-${++counter}-${Date.now()}`;
  }

  window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.kind === 'response' || msg.kind === 'error') {
      const req = pending.get(msg.id);
      if (!req) return;
      pending.delete(msg.id);
      clearTimeout(req.timer);
      if (msg.kind === 'error') {
        req.reject(new Error(typeof msg.error === 'string' ? msg.error : 'request failed'));
      } else {
        req.resolve(msg.result);
      }
      return;
    }

    if (msg.kind === 'sessionListChanged') {
      for (const h of handlers) h();
    }
  });

  function request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      api.postMessage({ kind: 'request', id, method, params });
    });
  }

  // Fire the subscription once at startup. The host treats it as idempotent.
  request<{ subscribed: boolean }>('subscribeSessionList').catch(() => { /* best-effort */ });

  return {
    listOpenSessions: () => request<OpenSessionInfo[]>('listOpenSessions'),
    getGitBranchInfo: (cwd) =>
      request<{ branch: string; dirty: boolean } | null>('getGitBranchInfo', { cwd }),
    onSessionListChange(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    revealSession(sessionId) {
      api.postMessage({ kind: 'revealSession', sessionId });
    },
  };
}
