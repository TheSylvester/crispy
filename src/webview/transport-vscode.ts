/**
 * VS Code Webview Transport — postMessage implementation
 *
 * Uses acquireVsCodeApi().postMessage() for requests and
 * window.addEventListener('message') for responses + events.
 *
 * @module transport-vscode
 */

import type { HostEvent } from '../host/client-connection.js';
import type { SessionService, WireSessionInfo } from './transport.js';
import type { TranscriptEntry } from '../core/transcript.js';
import type { TurnReceipt } from '../core/agent-adapter.js';

interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** Pending request awaiting a response. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

let requestCounter = 0;

function nextId(): string {
  return `vsc-${++requestCounter}-${Date.now()}`;
}

export function createVSCodeTransport(api: VSCodeAPI): SessionService {
  const pending = new Map<string, PendingRequest>();
  const eventHandlers: Array<(sessionId: string, event: HostEvent) => void> = [];

  function onMessage(ev: MessageEvent): void {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.kind === 'response' || msg.kind === 'error') {
      const req = pending.get(msg.id);
      if (!req) return;
      pending.delete(msg.id);
      clearTimeout(req.timer);

      if (msg.kind === 'error') {
        req.reject(new Error(msg.error));
      } else {
        req.resolve(msg.result);
      }
      return;
    }

    if (msg.kind === 'event') {
      for (const handler of eventHandlers) {
        handler(msg.sessionId, msg.event);
      }
    }
  }

  window.addEventListener('message', onMessage);

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

  return {
    listSessions: () => request<WireSessionInfo[]>('listSessions'),

    findSession: (sessionId) =>
      request<WireSessionInfo | null>('findSession', { sessionId }),

    loadSession: (sessionId, options) =>
      request<TranscriptEntry[]>('loadSession', { sessionId, ...options }),

    sendTurn: (intent) =>
      request<TurnReceipt>('sendTurn', { intent }),

    forkToNewPanel: (params) =>
      request<{ ok: boolean }>('forkToNewPanel', params),

    subscribe: (sessionId) =>
      request<void>('subscribe', { sessionId }),

    unsubscribe: (sessionId) =>
      request<void>('unsubscribe', { sessionId }),

    resolveApproval: (sessionId, toolUseId, optionId, extra) =>
      request<void>('resolveApproval', { sessionId, toolUseId, optionId, extra }),

    interrupt: (sessionId) =>
      request<void>('interrupt', { sessionId }),

    close: (sessionId) =>
      request<void>('close', { sessionId }),

    subscribeSessionList: () => request<void>('subscribeSessionList'),
    unsubscribeSessionList: () => request<void>('unsubscribeSessionList'),

    getGitFiles: (cwd) => request<string[]>('getGitFiles', { cwd }),
    fileExists: (path) => request<boolean>('fileExists', { path }),
    readImage: (path) => request<{ data: string; mimeType: string; fileName: string }>('readImage', { path }),
    openFile: (path, line, col) => request<{ opened: boolean }>('openFile', { path, line, col }),
    pickFile: (candidates) => request<{ picked: string | null }>('pickFile', { candidates }),

    onEvent(handler) {
      eventHandlers.push(handler);
      return () => {
        const i = eventHandlers.indexOf(handler);
        if (i >= 0) eventHandlers.splice(i, 1);
      };
    },

    dispose() {
      window.removeEventListener('message', onMessage);
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Transport disposed'));
      }
      pending.clear();
      eventHandlers.length = 0;
    },
  };
}
