/**
 * WebSocket Transport — Browser WebSocket implementation
 *
 * Used in Chrome dev mode. Same request/response correlation pattern
 * as the VS Code transport.
 *
 * @module transport-websocket
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

  ws.addEventListener('error', () => {
    // WebSocket errors don't carry detail — the close event follows immediately.
    // Reject all pending requests so callers surface the failure.
    for (const [, req] of pending) {
      clearTimeout(req.timer);
      req.reject(new Error('WebSocket connection failed — the daemon may not be running or may have rejected the connection'));
    }
    pending.clear();
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

  function request<T>(method: string, params?: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
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

  return {
    listSessions: () => request<WireSessionInfo[]>('listSessions'),

    findSession: (sessionId) =>
      request<WireSessionInfo | null>('findSession', { sessionId }),

    loadSession: (sessionId, options) =>
      request<TranscriptEntry[]>('loadSession', { sessionId, ...options }),

    sendTurn: (intent, pendingId) =>
      request<TurnReceipt>('sendTurn', { intent, ...(pendingId && { pendingId }) }),

    switchSession: (params) =>
      request<{ previousSessionId: string; sessionId: string }>('switchSession', params),

    openPanel: async (params) => {
      const createWindow = (window as any).__CRISPY_CREATE_WINDOW__;
      if (createWindow) {
        await createWindow(`sessionId=${encodeURIComponent(params.sessionId)}`);
        return { ok: true };
      }
      const url = new URL(window.location.pathname, window.location.origin);
      url.searchParams.set('sessionId', params.sessionId);
      window.open(url.toString(), '_blank');
      return { ok: true };
    },

    forkToNewPanel: async (params) => {
      const qp = new URLSearchParams();
      qp.set('forkFrom', params.fromSessionId);
      if (params.atMessageId) qp.set('forkAt', params.atMessageId);
      if (params.initialPrompt) qp.set('prompt', params.initialPrompt);
      if (params.model) qp.set('model', params.model);
      if (params.agencyMode) qp.set('agency', params.agencyMode);
      if (params.bypassEnabled) qp.set('bypass', '1');
      if (params.chromeEnabled) qp.set('chrome', '1');

      const createWindow = (window as any).__CRISPY_CREATE_WINDOW__;
      if (createWindow) {
        await createWindow(qp.toString());
        return { ok: true };
      }
      // Non-Tauri fallback
      const url = new URL(window.location.pathname, window.location.origin);
      url.search = qp.toString();
      window.open(url.toString(), '_blank');
      return { ok: true };
    },

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
    subscribeLog: () => request<void>('subscribeLog'),
    unsubscribeLog: () => request<void>('unsubscribeLog'),
    subscribeRecallCatchup: () => request<{ subscribed: boolean }>('subscribeRecallCatchup'),
    unsubscribeRecallCatchup: () => request<{ unsubscribed: boolean }>('unsubscribeRecallCatchup'),
    startEmbeddingBackfill: () => request<{ ok: boolean }>('startEmbeddingBackfill'),
    stopEmbeddingBackfill: () => request<{ ok: boolean }>('stopEmbeddingBackfill'),
    getCatchupStatus: () => request<CatchupStatus>('getCatchupStatus'),

    subscribeTrackerNotify: () => request<void>('subscribeTrackerNotify'),
    unsubscribeTrackerNotify: () => request<void>('unsubscribeTrackerNotify'),

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
