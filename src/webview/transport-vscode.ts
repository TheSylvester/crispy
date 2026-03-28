/**
 * VS Code Webview Transport — postMessage implementation
 *
 * Uses acquireVsCodeApi().postMessage() for requests and
 * window.addEventListener('message') for responses + events.
 *
 * @module transport-vscode
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

      api.postMessage({ kind: 'request', id, method, params });
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

    openPanel: (params) =>
      request<{ ok: boolean }>('openPanel', params),

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
      // 120s timeout: first-run model download can take 60s+
      return request<{ text: string }>('transcribeAudio', { audioBase64, sampleRate }, 120_000);
    },

    startVoiceCapture: () => request<void>('startVoiceCapture'),
    // Longer timeout: first call may download + load VAD/STT models
    stopVoiceCapture: () => request<{ text: string }>('stopVoiceCapture', undefined, 120_000),

    listWorkspaces: () => request<WorkspaceListResponse>('listWorkspaces'),
    addWorkspaceRoot: (path) => request<{ ok: boolean }>('addWorkspaceRoot', { path }),
    removeWorkspaceRoot: (path) => request<{ ok: boolean }>('removeWorkspaceRoot', { path }),

    listAvailableCommands: (params) =>
      request<InputCommand[]>('listAvailableCommands', params),

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

    postRaw(msg: unknown): void {
      api.postMessage(msg);
    },
  };
}
