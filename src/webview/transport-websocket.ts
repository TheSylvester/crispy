/**
 * WebSocket Transport — Browser WebSocket implementation
 *
 * Used in Chrome dev mode. Same request/response correlation pattern
 * as the VS Code transport. Includes auto-reconnect with exponential
 * backoff and connection state tracking.
 *
 * @module transport-websocket
 */

import type { HostEvent } from '../host/client-connection.js';
import type { TunnelStatusInfo } from '../host/tunnel-client.js';
import type { SessionService, WireSessionInfo, WireProject, WireProjectActivity, WireStage, OpenSessionInfo } from './transport.js';
import type { WorkspaceListResponse } from '../core/workspace-roots.js';
import type { TranscriptEntry } from '../core/transcript.js';
import type { TurnReceipt } from '../core/agent-adapter.js';
import type { WireProviderConfig, WireSettingsSnapshot, SettingsPatch } from '../core/settings/types.js';
import type { VendorModelGroup } from './components/control-panel/types.js';
import type { CatchupStatus } from '../core/recall/catchup-types.js';
import type { GitDiffResult } from '../core/git-diff-service.js';
import type { InputCommand } from '../core/input-command-service.js';
import type { ImportPlan, ImportReport, Resolutions } from '../core/import-types.js';
import { float32ToBase64 } from './utils/encoding.js';

/** Pending request awaiting a response. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const REQUEST_TIMEOUT_MS = 30_000;

/** Backoff schedule: 1s, 2s, 4s, 8s, 10s (cap) */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

let requestCounter = 0;

function nextId(): string {
  return `ws-${++requestCounter}-${Date.now()}`;
}

export function createWebSocketTransport(url: string): SessionService & {
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
  getConnectionState(): ConnectionState;
} {
  const pending = new Map<string, PendingRequest>();
  const eventHandlers: Array<(sessionId: string, event: HostEvent) => void> = [];
  const connectionStateHandlers: Array<(state: ConnectionState) => void> = [];
  const tunnelStatusHandlers: Array<(info: TunnelStatusInfo) => void> = [];

  let ws: WebSocket | null = null;
  let connectionState: ConnectionState = 'connecting';
  let isOpen = false;
  let disposed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic generation counter — prevents stale close handlers from clobbering a newer connection. */
  let wsGeneration = 0;

  /** Queue messages until the socket is open. */
  const sendQueue: string[] = [];

  /** Subscriptions to re-establish on reconnect */
  const activeSubscriptions = new Set<string>();
  let sessionListSubscribed = false;
  let logSubscribed = false;
  let trackerNotifySubscribed = false;
  let recallCatchupSubscribed = false;
  let importProgressSubscribed = false;

  function setConnectionState(state: ConnectionState): void {
    if (state === connectionState) return;
    connectionState = state;
    for (const handler of connectionStateHandlers) {
      handler(state);
    }
  }

  function connect(): void {
    if (disposed) return;

    // Close any lingering previous socket to avoid stale close events.
    // The browser may not have fired close yet for the old instance.
    if (ws) {
      try { ws.close(); } catch { /* already closed */ }
      ws = null;
    }

    const gen = ++wsGeneration;
    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener('open', () => {
      // Stale open from a superseded connection — ignore
      if (gen !== wsGeneration) { try { socket.close(); } catch {} return; }

      isOpen = true;
      reconnectAttempt = 0;
      setConnectionState('connected');

      // Re-establish subscriptions before flushing the queue.
      // The server rejects RPCs like sendTurn if the connection hasn't
      // subscribed to the target session yet.
      resubscribe();

      // Flush queued messages (sent while disconnected/reconnecting)
      for (const queued of sendQueue) {
        socket.send(queued);
      }
      sendQueue.length = 0;
    });

    socket.addEventListener('message', (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      // Intercept tunnel-status before reaching event handlers
      if (msg.kind === 'tunnel-status') {
        const info: TunnelStatusInfo = { status: msg.status as TunnelStatusInfo['status'] };
        if (msg.reason) info.reason = msg.reason as TunnelStatusInfo['reason'];
        for (const handler of tunnelStatusHandlers) {
          handler(info);
        }
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

    socket.addEventListener('error', () => {
      // WebSocket errors don't carry detail — the close event follows immediately.
    });

    socket.addEventListener('close', () => {
      // Stale close from a superseded connection — ignore
      if (gen !== wsGeneration) return;

      isOpen = false;
      ws = null;

      // Reject pending requests — they won't get responses on a dead socket
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('WebSocket closed'));
      }
      pending.clear();

      // Drop queued messages — their corresponding promises were just rejected.
      // Without this, timed-out requests would replay on the next connection
      // with no pending entry to receive the response.
      sendQueue.length = 0;

      if (!disposed) {
        scheduleReconnect();
      }
    });
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return; // already scheduled
    setConnectionState('reconnecting');
    const delay = BACKOFF_MS[Math.min(reconnectAttempt, BACKOFF_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  /** Re-subscribe to sessions and channels after reconnect */
  function resubscribe(): void {
    for (const sessionId of activeSubscriptions) {
      sendRaw(JSON.stringify({ kind: 'request', id: nextId(), method: 'subscribe', params: { sessionId } }));
    }
    if (sessionListSubscribed) {
      sendRaw(JSON.stringify({ kind: 'request', id: nextId(), method: 'subscribeSessionList' }));
    }
    if (logSubscribed) {
      sendRaw(JSON.stringify({ kind: 'request', id: nextId(), method: 'subscribeLog' }));
    }
    if (trackerNotifySubscribed) {
      sendRaw(JSON.stringify({ kind: 'request', id: nextId(), method: 'subscribeTrackerNotify' }));
    }
    if (recallCatchupSubscribed) {
      sendRaw(JSON.stringify({ kind: 'request', id: nextId(), method: 'subscribeRecallCatchup' }));
    }
    if (importProgressSubscribed) {
      sendRaw(JSON.stringify({ kind: 'request', id: nextId(), method: 'subscribeImportProgress' }));
    }
  }

  function sendRaw(data: string): void {
    if (isOpen && ws) {
      ws.send(data);
    } else {
      sendQueue.push(data);
    }
  }

  function request<T>(method: string, params?: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (disposed) {
        reject(new Error('Transport disposed'));
        return;
      }

      const id = nextId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });

      sendRaw(JSON.stringify({ kind: 'request', id, method, params }));
    });
  }

  // Start initial connection
  connect();

  return {
    listSessions: () => request<WireSessionInfo[]>('listSessions'),

    listOpenSessions: (params) =>
      request<OpenSessionInfo[]>('listOpenSessions', (params ?? {}) as Record<string, unknown>),

    findSession: (sessionId) =>
      request<WireSessionInfo | null>('findSession', { sessionId }),

    loadSession: (sessionId, options) =>
      request<TranscriptEntry[]>('loadSession', { sessionId, ...options }),

    sendTurn: (intent, pendingId) =>
      request<TurnReceipt>('sendTurn', { intent, ...(pendingId && { pendingId }) }),

    switchSession: (params) =>
      request<{ previousSessionId: string; sessionId: string }>('switchSession', params),

    openPanel: async (params) => {
      if ((window as any).__CRISPY_CREATE_WINDOW__) {
        // Tauri: direct IPC via init script bridge
        const query = `sessionId=${encodeURIComponent(params.sessionId)}`;
        await (window as any).__CRISPY_CREATE_WINDOW__(query);
        return { ok: true };
      }
      const url = new URL(window.location.pathname, window.location.origin);
      url.searchParams.set('sessionId', params.sessionId);
      window.open(url.toString(), '_blank');
      return { ok: true };
    },

    // forkToNewPanel intentionally omitted — flex-layout handles fork via tabController

    subscribe: (sessionId) => {
      activeSubscriptions.add(sessionId);
      return request<void>('subscribe', { sessionId }).catch((err) => {
        activeSubscriptions.delete(sessionId);
        throw err;
      });
    },

    unsubscribe: (sessionId) => {
      activeSubscriptions.delete(sessionId);
      return request<void>('unsubscribe', { sessionId });
    },

    resolveApproval: (sessionId, toolUseId, optionId, extra) =>
      request<void>('resolveApproval', { sessionId, toolUseId, optionId, extra }),

    interrupt: (sessionId) =>
      request<void>('interrupt', { sessionId }),

    close: (sessionId) =>
      request<void>('close', { sessionId }),

    subscribeSessionList: () => {
      sessionListSubscribed = true;
      return request<void>('subscribeSessionList');
    },
    unsubscribeSessionList: () => {
      sessionListSubscribed = false;
      return request<void>('unsubscribeSessionList');
    },
    subscribeLog: () => {
      logSubscribed = true;
      return request<void>('subscribeLog');
    },
    unsubscribeLog: () => {
      logSubscribed = false;
      return request<void>('unsubscribeLog');
    },
    subscribeRecallCatchup: () => {
      recallCatchupSubscribed = true;
      return request<{ subscribed: boolean }>('subscribeRecallCatchup');
    },
    unsubscribeRecallCatchup: () => {
      recallCatchupSubscribed = false;
      return request<{ unsubscribed: boolean }>('unsubscribeRecallCatchup');
    },
    startEmbeddingBackfill: () => request<{ ok: boolean }>('startEmbeddingBackfill'),
    stopEmbeddingBackfill: () => request<{ ok: boolean }>('stopEmbeddingBackfill'),
    getCatchupStatus: () => request<CatchupStatus>('getCatchupStatus'),

    subscribeTrackerNotify: () => {
      trackerNotifySubscribed = true;
      return request<void>('subscribeTrackerNotify');
    },
    unsubscribeTrackerNotify: () => {
      trackerNotifySubscribed = false;
      return request<void>('unsubscribeTrackerNotify');
    },

    getStages: () => request<WireStage[]>('getStages'),
    getProjects: () => request<WireProject[]>('getProjects'),
    getProjectActivity: (projectId, opts) => request<WireProjectActivity[]>('getProjectActivity', { projectId, ...(opts?.kind && { kind: opts.kind }) }),
    updateProjectStage: (projectId, stage) => request<{ ok: boolean }>('updateProjectStage', { projectId, stage }),
    updateProjectSortOrder: (updates) => request<{ ok: boolean }>('updateProjectSortOrder', { updates }),

    getGitFiles: (cwd) => request<string[]>('getGitFiles', { cwd }),
    getGitBranchInfo: (cwd) => request<{ branch: string; dirty: boolean } | null>('getGitBranchInfo', { cwd }),
    getGitDiff: (cwd) => request<GitDiffResult>('getGitDiff', { cwd }),
    fileExists: (path) => request<boolean>('fileExists', { path }),
    readImage: (path) => request<{ data: string; mimeType: string; fileName: string }>('readImage', { path }),
    readFile: (path) => request<{ content: string; fileName: string; size: number }>('readFile', { path }),
    openFile: (path, line, col) => request<{ opened: boolean }>('openFile', { path, line, col }),
    pickFile: (candidates) => request<{ picked: string | null }>('pickFile', { candidates }),

    readSubagentEntries: (sessionId, agentId, parentToolUseId, cursor) =>
      request<{ entries: TranscriptEntry[]; cursor: string; done: boolean }>(
        'readSubagentEntries',
        { sessionId, agentId, parentToolUseId, cursor },
      ),

    listProviders: () => request<Record<string, WireProviderConfig>>('listProviders'),
    saveProvider: (slug, config) => request<{ saved: boolean }>('saveProvider', { slug, config }),
    deleteProvider: (slug) => request<{ deleted: boolean }>('deleteProvider', { slug }),
    getModelGroups: () => request<VendorModelGroup[]>('getModelGroups'),

    getSettings: () => request<WireSettingsSnapshot>('getSettings'),
    updateSettings: (patch, opts) => request<WireSettingsSnapshot>('updateSettings', { patch, ...opts }),

    getResponsePreview: (file, offset) => request<string | null>('getResponsePreview', { file, offset }),
    getLineageGraph: () => request<Array<{ sessionFile: string; parentFile: string | null }>>('getLineageGraph'),

    transcribeAudio: (pcmFloat32, sampleRate) => {
      const audioBase64 = float32ToBase64(pcmFloat32);
      console.log(`[Voice] transport: sending transcribeAudio RPC, ${pcmFloat32.length} samples, base64 length: ${audioBase64.length}`);
      // 120s timeout: first-run model download can take 60s+
      return request<{ text: string }>('transcribeAudio', { audioBase64, sampleRate }, 120_000);
    },

    onEvent(handler) {
      eventHandlers.push(handler);
      return () => {
        const i = eventHandlers.indexOf(handler);
        if (i >= 0) eventHandlers.splice(i, 1);
      };
    },

    listWorkspaces: () => request<WorkspaceListResponse>('listWorkspaces'),
    addWorkspaceRoot: (path) => request<{ ok: boolean }>('addWorkspaceRoot', { path }),
    removeWorkspaceRoot: (path) => request<{ ok: boolean }>('removeWorkspaceRoot', { path }),

    listAvailableCommands: (params) =>
      request<InputCommand[]>('listAvailableCommands', params),

    validateDiscordToken: (token) =>
      request<{ valid: boolean; username?: string; id?: string; error?: string }>('validateDiscordToken', { token }),

    getDiscordAppInfo: (token) =>
      request<{ appId: string; name: string } | null>('getDiscordAppInfo', { token }),

    // --- Terminal ---
    createTerminal: (opts) =>
      request<{ terminalId: string }>('createTerminal', opts as Record<string, unknown>),
    writeTerminal: (terminalId, data) =>
      request<void>('writeTerminal', { terminalId, data }),
    resizeTerminal: (terminalId, cols, rows) =>
      request<void>('resizeTerminal', { terminalId, cols, rows }),
    closeTerminal: (terminalId) =>
      request<void>('closeTerminal', { terminalId }),
    listTerminals: () =>
      request<string[]>('listTerminals'),
    attachTerminal: (terminalId) =>
      request<boolean>('attachTerminal', { terminalId }),
    onTerminalData(terminalId: string, cb: (data: string) => void): () => void {
      return this.onEvent((sessionId, event) => {
        if (sessionId === `terminal:${terminalId}` && (event as any).type === 'terminal_data') {
          cb((event as any).data);
        }
      });
    },

    // --- OS-drop import (Tauri shell) ---
    previewImport: (args) => request<ImportPlan>('previewImport', args as Record<string, unknown>),
    executeImport: (args) => request<ImportReport>('executeImport', args as Record<string, unknown>),
    cancelImport: (args) => request<{ cancelled: boolean }>('cancelImport', args as Record<string, unknown>),
    subscribeImportProgress: () => {
      importProgressSubscribed = true;
      return request<{ subscribed: boolean }>('subscribeImportProgress');
    },
    unsubscribeImportProgress: () => {
      importProgressSubscribed = false;
      return request<{ unsubscribed: boolean }>('unsubscribeImportProgress');
    },

    getTunnelStatus: () => request<TunnelStatusInfo>('getTunnelStatus'),

    onTunnelStatusChange(handler: (info: TunnelStatusInfo) => void): () => void {
      tunnelStatusHandlers.push(handler);
      return () => {
        const i = tunnelStatusHandlers.indexOf(handler);
        if (i >= 0) tunnelStatusHandlers.splice(i, 1);
      };
    },

    dispose() {
      disposed = true;
      wsGeneration++; // invalidate any in-flight connection events
      setConnectionState('disconnected');
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Transport disposed'));
      }
      pending.clear();
      eventHandlers.length = 0;
      connectionStateHandlers.length = 0;
      tunnelStatusHandlers.length = 0;
    },

    // --- Connection state ---
    onConnectionStateChange(handler: (state: ConnectionState) => void): () => void {
      connectionStateHandlers.push(handler);
      return () => {
        const i = connectionStateHandlers.indexOf(handler);
        if (i >= 0) connectionStateHandlers.splice(i, 1);
      };
    },

    getConnectionState(): ConnectionState {
      return connectionState;
    },
  };
}
