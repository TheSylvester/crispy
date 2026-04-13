/**
 * Cloud Relay Transport — Browser WebSocket to relay server
 *
 * Nearly identical to transport-websocket.ts. Differences:
 * 1. Connects to relay URL with tunnelId query param
 * 2. Auth via cookie (same-origin, automatic)
 * 3. Handles { kind: 'tunnel-status' } messages from relay
 * 4. Exports tunnel online/offline state for UI consumption
 *
 * @module transport-cloud-relay
 */

import type { HostEvent } from '../host/client-connection.js';
import type { SessionService, WireSessionInfo, WireProject, WireProjectActivity, WireStage } from './transport.js';
import type { WorkspaceListResponse } from '../core/workspace-roots.js';
import type { TranscriptEntry } from '../core/transcript.js';
import type { TurnReceipt } from '../core/agent-adapter.js';
import type { WireProviderConfig, WireSettingsSnapshot, SettingsPatch } from '../core/settings/types.js';
import type { VendorModelGroup } from './components/control-panel/types.js';
import type { CatchupStatus } from '../core/recall/catchup-types.js';
import type { GitDiffResult } from '../core/git-diff-service.js';
import type { InputCommand } from '../core/input-command-service.js';
import { float32ToBase64 } from './utils/encoding.js';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

let requestCounter = 0;
function nextId(): string {
  return `cr-${++requestCounter}-${Date.now()}`;
}

export function createCloudRelayTransport(wsUrl: string, tunnelId: string): SessionService & {
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
  getConnectionState(): ConnectionState;
  onTunnelStatusChange(handler: (connected: boolean) => void): () => void;
  isTunnelConnected(): boolean;
} {
  const pending = new Map<string, PendingRequest>();
  const eventHandlers: Array<(sessionId: string, event: HostEvent) => void> = [];
  const connectionStateHandlers: Array<(state: ConnectionState) => void> = [];
  const tunnelStatusHandlers: Array<(connected: boolean) => void> = [];

  let ws: WebSocket | null = null;
  let connectionState: ConnectionState = 'connecting';
  let tunnelConnected = false;
  let isOpen = false;
  let disposed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsGeneration = 0;

  const sendQueue: string[] = [];

  const activeSubscriptions = new Set<string>();
  let sessionListSubscribed = false;
  let logSubscribed = false;
  let trackerNotifySubscribed = false;
  let recallCatchupSubscribed = false;

  function setConnectionState(state: ConnectionState): void {
    if (state === connectionState) return;
    connectionState = state;
    for (const handler of connectionStateHandlers) {
      handler(state);
    }
  }

  function setTunnelConnected(connected: boolean): void {
    if (connected === tunnelConnected) return;
    tunnelConnected = connected;
    for (const handler of tunnelStatusHandlers) {
      handler(connected);
    }
  }

  function connect(): void {
    if (disposed) return;

    if (ws) {
      try { ws.close(); } catch { /* already closed */ }
      ws = null;
    }

    const gen = ++wsGeneration;
    // Connect to relay with tunnelId — auth is via cookie (same-origin)
    const url = `${wsUrl}?tunnelId=${encodeURIComponent(tunnelId)}`;
    const socket = new WebSocket(url);
    ws = socket;

    socket.addEventListener('open', () => {
      if (gen !== wsGeneration) { try { socket.close(); } catch {} return; }

      isOpen = true;
      reconnectAttempt = 0;
      setConnectionState('connected');

      resubscribe();

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
        setTunnelConnected(msg.connected as boolean);
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
      // close event follows immediately
    });

    socket.addEventListener('close', () => {
      if (gen !== wsGeneration) return;

      isOpen = false;
      ws = null;

      for (const [, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('WebSocket closed'));
      }
      pending.clear();
      sendQueue.length = 0;

      if (!disposed) {
        scheduleReconnect();
      }
    });
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    setConnectionState('reconnecting');
    const delay = BACKOFF_MS[Math.min(reconnectAttempt, BACKOFF_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

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
    findSession: (sessionId) => request<WireSessionInfo | null>('findSession', { sessionId }),
    loadSession: (sessionId, options) => request<TranscriptEntry[]>('loadSession', { sessionId, ...options }),
    sendTurn: (intent, pendingId) => request<TurnReceipt>('sendTurn', { intent, ...(pendingId && { pendingId }) }),
    switchSession: (params) => request<{ previousSessionId: string; sessionId: string }>('switchSession', params),

    openPanel: async (params) => {
      // In cloud relay mode, open a new browser tab to the same relay
      const relayOrigin = (window as any).__CRISPY_CLOUD__?.relayOrigin || window.location.origin;
      const url = `${relayOrigin}/session/${tunnelId}?sessionId=${encodeURIComponent(params.sessionId)}`;
      window.open(url, '_blank');
      return { ok: true };
    },

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
    interrupt: (sessionId) => request<void>('interrupt', { sessionId }),
    close: (sessionId) => request<void>('close', { sessionId }),

    subscribeSessionList: () => { sessionListSubscribed = true; return request<void>('subscribeSessionList'); },
    unsubscribeSessionList: () => { sessionListSubscribed = false; return request<void>('unsubscribeSessionList'); },
    subscribeLog: () => { logSubscribed = true; return request<void>('subscribeLog'); },
    unsubscribeLog: () => { logSubscribed = false; return request<void>('unsubscribeLog'); },
    subscribeRecallCatchup: () => { recallCatchupSubscribed = true; return request<{ subscribed: boolean }>('subscribeRecallCatchup'); },
    unsubscribeRecallCatchup: () => { recallCatchupSubscribed = false; return request<{ unsubscribed: boolean }>('unsubscribeRecallCatchup'); },
    startEmbeddingBackfill: () => request<{ ok: boolean }>('startEmbeddingBackfill'),
    stopEmbeddingBackfill: () => request<{ ok: boolean }>('stopEmbeddingBackfill'),
    getCatchupStatus: () => request<CatchupStatus>('getCatchupStatus'),

    subscribeTrackerNotify: () => { trackerNotifySubscribed = true; return request<void>('subscribeTrackerNotify'); },
    unsubscribeTrackerNotify: () => { trackerNotifySubscribed = false; return request<void>('unsubscribeTrackerNotify'); },

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
        'readSubagentEntries', { sessionId, agentId, parentToolUseId, cursor }),

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

    listAvailableCommands: (params) => request<InputCommand[]>('listAvailableCommands', params),

    validateDiscordToken: (token) =>
      request<{ valid: boolean; username?: string; id?: string; error?: string }>('validateDiscordToken', { token }),
    getDiscordAppInfo: (token) =>
      request<{ appId: string; name: string } | null>('getDiscordAppInfo', { token }),

    createTerminal: (opts) => request<{ terminalId: string }>('createTerminal', opts as Record<string, unknown>),
    writeTerminal: (terminalId, data) => request<void>('writeTerminal', { terminalId, data }),
    resizeTerminal: (terminalId, cols, rows) => request<void>('resizeTerminal', { terminalId, cols, rows }),
    closeTerminal: (terminalId) => request<void>('closeTerminal', { terminalId }),
    listTerminals: () => request<string[]>('listTerminals'),
    attachTerminal: (terminalId) => request<boolean>('attachTerminal', { terminalId }),
    onTerminalData(terminalId: string, cb: (data: string) => void): () => void {
      return this.onEvent((sessionId, event) => {
        if (sessionId === `terminal:${terminalId}` && (event as any).type === 'terminal_data') {
          cb((event as any).data);
        }
      });
    },

    dispose() {
      disposed = true;
      wsGeneration++;
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

    onTunnelStatusChange(handler: (connected: boolean) => void): () => void {
      tunnelStatusHandlers.push(handler);
      return () => {
        const i = tunnelStatusHandlers.indexOf(handler);
        if (i >= 0) tunnelStatusHandlers.splice(i, 1);
      };
    },

    isTunnelConnected(): boolean {
      return tunnelConnected;
    },
  };
}
