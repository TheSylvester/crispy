/**
 * WebSocket Transport — Browser WebSocket implementation
 *
 * Used in Chrome dev mode. Same request/response correlation pattern
 * as the VS Code transport.
 *
 * @module transport-websocket
 */

import type { HostEvent } from '../host/client-connection.js';
import type { SessionService, WireSessionInfo } from './transport.js';
import type { TranscriptEntry } from '../core/transcript.js';

/** Pending request awaiting a response. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

let requestCounter = 0;

function nextId(): string {
  return `ws-${++requestCounter}-${Date.now()}`;
}

export function createWebSocketTransport(url: string): SessionService {
  const pending = new Map<string, PendingRequest>();
  const eventHandlers: Array<(sessionId: string, event: HostEvent) => void> = [];
  const ws = new WebSocket(url);

  /** Queue messages until the socket is open. */
  const sendQueue: string[] = [];
  let isOpen = false;

  ws.addEventListener('open', () => {
    isOpen = true;
    for (const queued of sendQueue) {
      ws.send(queued);
    }
    sendQueue.length = 0;
  });

  ws.addEventListener('message', (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.kind === 'response' || msg.kind === 'error') {
      const req = pending.get(msg.id as string);
      if (!req) return;
      pending.delete(msg.id as string);
      clearTimeout(req.timer);

      if (msg.kind === 'error') {
        req.reject(new Error(msg.error as string));
      } else {
        req.resolve(msg.result);
      }
      return;
    }

    if (msg.kind === 'event') {
      const event = msg.event as HostEvent;
      const sessionId = msg.sessionId as string;
      for (const handler of eventHandlers) {
        handler(sessionId, event);
      }
    }
  });

  ws.addEventListener('close', () => {
    isOpen = false;
    for (const [, req] of pending) {
      clearTimeout(req.timer);
      req.reject(new Error('WebSocket closed'));
    }
    pending.clear();
  });

  function sendRaw(data: string): void {
    if (isOpen) {
      ws.send(data);
    } else {
      sendQueue.push(data);
    }
  }

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

      sendRaw(JSON.stringify({ kind: 'request', id, method, params }));
    });
  }

  return {
    listSessions: () => request<WireSessionInfo[]>('listSessions'),

    findSession: (sessionId) =>
      request<WireSessionInfo | null>('findSession', { sessionId }),

    loadSession: (sessionId, options) =>
      request<TranscriptEntry[]>('loadSession', { sessionId, ...options }),

    createSession: (vendor, cwd, options) =>
      request<{ pendingId: string }>('createSession', { vendor, cwd, ...options }),

    forkSession: (vendor, fromSessionId, options) =>
      request<{ pendingId: string }>('forkSession', { vendor, fromSessionId, ...options }),

    forkToNewPanel: async (params) => {
      // Browser dev-server: open fork in a new tab via window.open()
      const url = new URL(window.location.href);
      url.searchParams.set('forkFrom', params.fromSessionId);
      if (params.atMessageId) url.searchParams.set('forkAt', params.atMessageId);
      if (params.initialPrompt) url.searchParams.set('prompt', params.initialPrompt);
      if (params.model) url.searchParams.set('model', params.model);
      if (params.agencyMode) url.searchParams.set('agency', params.agencyMode);
      if (params.bypassEnabled) url.searchParams.set('bypass', '1');
      if (params.chromeEnabled) url.searchParams.set('chrome', '1');
      window.open(url.toString(), '_blank');
      return { ok: true };
    },

    subscribe: (sessionId) =>
      request<void>('subscribe', { sessionId }),

    unsubscribe: (sessionId) =>
      request<void>('unsubscribe', { sessionId }),

    send: (sessionId, content, options) =>
      request<void>('send', { sessionId, content, options }),

    resolveApproval: (sessionId, toolUseId, optionId, extra) =>
      request<void>('resolveApproval', { sessionId, toolUseId, optionId, extra }),

    setModel: (sessionId, model) =>
      request<void>('setModel', { sessionId, model }),

    setPermissions: (sessionId, mode) =>
      request<void>('setPermissions', { sessionId, mode }),

    interrupt: (sessionId) =>
      request<void>('interrupt', { sessionId }),

    reconfigure: (sessionId, updates) =>
      request<void>('reconfigure', { sessionId, ...updates }),

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
      ws.close();
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Transport disposed'));
      }
      pending.clear();
      eventHandlers.length = 0;
    },
  };
}
