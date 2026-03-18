/**
 * Client Connection — per-client lifecycle management
 *
 * The key to zero duplication between dev-server (WebSocket) and
 * webview-host (postMessage). Both transports create a connection via
 * createClientConnection() and feed it raw messages.
 *
 * Internally tracks active subscriptions so dispose() can clean up
 * when a client disconnects.
 *
 * @module client-connection
 */

import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import type { TurnIntent, ChannelMessage } from "../core/agent-adapter.js";
import type {
  Subscriber,
  SessionChannel,
  SubscriberMessage,
} from "../core/session-channel.js";
import type { SessionListEvent } from "../core/session-list-events.js";
import {
  getSettingsSnapshot, updateSettings, deleteProvider,
  onSettingsChanged, getModelGroups,
} from '../core/settings/index.js';
import { SETTINGS_CHANNEL_ID } from '../core/settings/events.js';
import type { SettingsChangedGlobalEvent } from '../core/settings/events.js';
import type { SettingsPatch, ProviderConfig } from '../core/settings/types.js';
import { resolveApproval, subscribe, unsubscribe } from "../core/session-channel.js";
import {
  listAllSessions,
  findSession,
  loadSession,
  subscribeSession,
  sendTurn,
  interruptSession,
  closeSession,
  readSubagentEntries,
  getRegisteredVendors,
  dispatchChildSession,
  resumeChildSession,
  registerChildSession,
  rekeyChildSession,
  resolveSessionId,
  resolveSessionPrefix,
} from "../core/session-manager.js";
import type { ChildSessionOptions, ResumeChildOptions } from "../core/session-manager.js";
import {
  subscribeSessionList,
  unsubscribeSessionList,
  type SessionListSubscriber,
} from "../core/session-list-manager.js";
import { SESSION_LIST_CHANNEL_ID } from "../core/session-list-events.js";
import {
  subscribeLog,
  unsubscribeLog,
  LOG_CHANNEL_ID,
  log,
} from "../core/log.js";
import type { LogEvent, LogSubscriber } from "../core/log.js";
import type { RecallCatchupEvent } from "../core/channel-events.js";
import {
  RECALL_CATCHUP_CHANNEL_ID,
  subscribeCatchup,
  unsubscribeCatchup,
  startEmbeddingBackfill,
  stopEmbeddingBackfill,
  getCatchupStatus,
  type CatchupSubscriber,
} from '../core/recall/catchup-manager.js';
import { readSessionMessages } from '../core/recall/message-store.js';
import { getGitFiles, fileExists, readImage, readTextFile } from "../core/file-service.js";
import { queryActivity, getLineage, getChildSessions, getLineageGraph, dbPath, setSessionTitle } from '../core/activity-index.js';
import { refreshAndNotify } from '../core/session-list-manager.js';
import { getProjectsWithDetails, getProjectActivity, updateProjectStage, updateProjectSortOrder, reorderProjectsInStage, getStages, getValidStageNames, writeTrackerResults, mergeProjects, extractTurnsFromMessages, getProjectTitle } from '../core/rosie/tracker/index.js';
import type { TrackerBlock } from '../core/rosie/tracker/index.js';
import { getDb } from '../core/crispy-db.js';
import {
  subscribeTrackerNotify,
  unsubscribeTrackerNotify,
  pushTrackerNotification,
  TRACKER_NOTIFY_CHANNEL_ID,
} from '../core/rosie/tracker/tracker-notifications.js';
import type { TrackerNotifyEvent, TrackerNotifySubscriber } from '../core/rosie/tracker/tracker-notifications.js';
import { readResponsePreview } from '../core/adapters/claude/jsonl-reader.js';
import { readCodexResponsePreview } from '../core/adapters/codex/codex-jsonl-reader.js';
// Voice module is lazy-loaded to avoid pulling onnxruntime-node native bindings
// at extension activation time (crashes VS Code's Electron host).
// import { transcribeAudio } from '../core/voice/index.js'; // <-- lazy below
import { startCapture, stopCapture, cancelCapture, cleanupOrphanedVoiceFiles } from './audio-capture.js';

// Clean up any orphaned voice temp files from previous sessions on module load.
cleanupOrphanedVoiceFiles();

// ============================================================================
// Streaming Log Formatter
// ============================================================================

/** Format a timestamp as HH:MM:SS for log lines. */
function logTimestamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Pretty-print a channel message for streaming log output. Returns null if the message should be skipped. */
function formatLogEntry(msg: ChannelMessage): string | null {
  const ts = logTimestamp();

  if (msg.type === 'entry') {
    const entry = msg.entry;
    if (entry.type === 'assistant' && entry.message) {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) texts.push(block.text);
          else if (block.type === 'tool_use') texts.push(`[tool: ${(block as { name?: string }).name ?? '?'}]`);
        }
        return texts.length > 0 ? `[${ts}] ${texts.join(' ')}` : null;
      }
      if (typeof content === 'string') return `[${ts}] ${content}`;
    }
    if (entry.type === 'result' && entry.message) {
      const content = entry.message.content;
      let text = '';
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) text += block.text;
        }
      } else if (typeof content === 'string') {
        text = content;
      }
      if (text) return `[${ts}] result: ${text.length > 200 ? text.slice(0, 200) + '…' : text}`;
    }
    return null;
  }

  if (msg.type === 'event' && msg.event.type === 'status') {
    return `[${ts}] status: ${msg.event.status}`;
  }

  return null;
}

// ============================================================================
// Path Containment
// ============================================================================

/** ~/.claude/ is always allowed (config, project metadata, history). */
const CLAUDE_CONFIG_DIR = resolve(homedir(), '.claude');

/**
 * Check that a resolved absolute path is contained within an allowed root.
 * Uses a prefix check with a trailing separator to prevent partial matches
 * (e.g. /home/user/project-evil matching /home/user/project).
 */
function isWithin(filePath: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  return filePath === root || filePath.startsWith(normalizedRoot);
}

// ============================================================================
// Wire Protocol Types
// ============================================================================

/** Client → Host request. */
export type ClientMessage = {
  kind: "request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

/** Union of all events that can be pushed over the wire. */
export type HostEvent = SubscriberMessage | SessionListEvent | SettingsChangedGlobalEvent | LogEvent | RecallCatchupEvent | TrackerNotifyEvent;

/** Host → Client response or push event. */
export type HostMessage =
  | { kind: "response"; id: string; result: unknown }
  | { kind: "error"; id: string; error: string }
  | { kind: "event"; sessionId: string; event: HostEvent };

// ============================================================================
// Client Connection
// ============================================================================

export type SendFn = (message: HostMessage) => void;

export interface ClientConnection {
  handleMessage(raw: unknown): Promise<void>;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** Register an extra directory root that file reads are allowed from. */
  addAllowedRoot(absolutePath: string): void;
  dispose(): void;
}

/**
 * Create a handler bound to a single client connection.
 *
 * @param clientId  Unique ID for this client (used as subscriber ID)
 * @param sendFn    Transport-specific send function
 */
export function createClientConnection(
  clientId: string,
  sendFn: SendFn,
): ClientConnection {
  /** Active subscriptions: sessionId → { channel, subscriber } */
  const subscriptions = new Map<
    string,
    {
      channel: SessionChannel;
      subscriber: Subscriber;
    }
  >();

  /** Global session-list subscription for this client. */
  let sessionListSub: SessionListSubscriber | null = null;

  /** Global rosie-log subscription for this client. */
  let rosieLogSub: LogSubscriber | null = null;

  /** Global recall catch-up subscription for this client. */
  let catchupSub: CatchupSubscriber | null = null;

  /** Tracker notification subscription for this client. */
  let trackerNotifySub: TrackerNotifySubscriber | null = null;

  /** Flag set on dispose() to prevent re-keying after client disconnect. */
  let disposed = false;

  /** Extra allowed roots (e.g. VS Code workspace CWD before any session exists). */
  const extraAllowedRoots = new Set<string>();

  /** Child sessions registered via provenance — cleaned up on dispose (fix #7). */
  const registeredChildren = new Set<string>();

  /**
   * Validate that `filePath` is inside an allowed directory before performing
   * any file-system read. Allowed roots:
   *   1. The projectPath (cwd) of any session this client is subscribed to.
   *   2. ~/.claude/ — needed for config, project metadata, and history.
   *
   * Throws if the path escapes all allowed roots.
   */
  function assertPathAllowed(filePath: string): void {
    const resolved = resolve(filePath);

    // Always allow ~/.claude/
    if (isWithin(resolved, CLAUDE_CONFIG_DIR)) return;

    // Allow extra roots (e.g. VS Code workspace CWD)
    for (const root of extraAllowedRoots) {
      if (isWithin(resolved, root)) return;
    }

    // Allow any subscribed session's project directory
    for (const [sessionId] of subscriptions) {
      const info = findSession(sessionId);
      if (info?.projectPath && isWithin(resolved, resolve(info.projectPath))) {
        return;
      }
    }

    throw new Error(
      `Path "${filePath}" is outside the workspace. File access is restricted to session working directories and ~/.claude/.`,
    );
  }

  /** Push settings updates when settings.json changes. */
  const settingsUnsub = onSettingsChanged(({ snapshot, changedSections }) => {
    sendFn({
      kind: 'event',
      sessionId: SETTINGS_CHANNEL_ID,
      event: { type: 'settings_snapshot', snapshot, changedSections },
    });
  });

  async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return routeMethod(method, params);
  }

  async function handleMessage(raw: unknown): Promise<void> {
    // Parse the message
    const msg = (
      typeof raw === "string" ? JSON.parse(raw) : raw
    ) as ClientMessage;

    if (msg.kind !== "request" || !msg.id || !msg.method) {
      return; // Ignore malformed messages
    }

    const { id, method, params } = msg;

    try {
      const result = await call(method, params ?? {});
      sendFn({ kind: "response", id, result });
    } catch (err) {
      sendFn({
        kind: "error",
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function routeMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "listSessions":
        return listAllSessions();

      case "findSession":
        return findSession(params.sessionId as string) ?? null;

      case "loadSession":
        return loadSession(params.sessionId as string, {
          until: params.until as string | undefined,
        });

      case "readSessionTurns": {
        const sid = params.sessionId as string;
        const page = readSessionMessages(sid, 0, 10000);
        if (!page) return [];
        const allTurns = extractTurnsFromMessages(page.messages);
        const from = (params.from as number | undefined) ?? 1;
        const to = (params.to as number | undefined) ?? allTurns.length;
        return allTurns.filter(t => t.turn >= from && t.turn <= to);
      }

      case "subscribe": {
        const sessionId = params.sessionId as string;

        // Already subscribed — resend catchup so the client can resync
        // after a pending→real handoff or listener race without creating
        // a duplicate subscriber. Channel-owned entries are used for catchup.
        const existing = subscriptions.get(sessionId);
        if (existing) {
          subscribe(existing.channel, existing.subscriber);
          return { subscribed: true };
        }

        const subscriber: Subscriber = {
          id: clientId,
          send(event: SubscriberMessage) {
            sendFn({ kind: "event", sessionId, event });
          },
        };

        const channel = await subscribeSession(sessionId, subscriber);
        subscriptions.set(sessionId, { channel, subscriber });
        return { subscribed: true };
      }

      case "unsubscribe": {
        const sessionId = params.sessionId as string;
        const sub = subscriptions.get(sessionId);
        if (sub) {
          unsubscribe(sub.channel, sub.subscriber);
          subscriptions.delete(sessionId);
        }
        return { unsubscribed: true };
      }

      case "sendTurn": {
        const intent = params.intent as TurnIntent;

        // Optional provenance: marks this session as an IPC-dispatched child.
        // Prevents Rosie from processing it while optionally allowing UI visibility.
        const provenance = params.provenance as {
          parentSessionId: string;
          autoClose: boolean;
          visible: boolean;
        } | undefined;

        /**
         * Create a mutable subscriber that allows session ID re-keying.
         * The rekey() method updates the session ID used in event routing.
         */
        function createMutableSubscriber(initialSessionId: string) {
          let currentSessionId = initialSessionId;
          const subscriber: Subscriber = {
            id: clientId,
            send(event: SubscriberMessage) {
              if (disposed) return;
              sendFn({ kind: "event", sessionId: currentSessionId, event });
            },
          };
          return {
            subscriber,
            rekey(newId: string) { currentSessionId = newId; },
          };
        }

        // For existing sessions — may trigger vendor switch internally
        if (intent.target.kind === 'existing') {
          const targetSessionId = intent.target.sessionId;
          const sub = subscriptions.get(targetSessionId);
          if (!sub) {
            throw new Error(
              `Not subscribed to session "${targetSessionId}". Call subscribe first.`
            );
          }

          // Swap to mutable subscriber BEFORE sendTurn to avoid event-loss window.
          // The mutable subscriber is already installed on the channel when
          // sendTurn() potentially triggers a vendor switch.
          unsubscribe(sub.channel, sub.subscriber);
          const mutable = createMutableSubscriber(targetSessionId);
          subscribe(sub.channel, mutable.subscriber);
          subscriptions.set(targetSessionId, {
            channel: sub.channel, subscriber: mutable.subscriber,
          });

          const result = await sendTurn(intent, mutable.subscriber);

          // Register provenance if this is an IPC-dispatched child
          if (provenance) {
            registerChildSession(result.sessionId, provenance);
            registeredChildren.add(result.sessionId);
          }

          // If vendor switch happened, update subscription tracking
          if (result.sessionId !== targetSessionId) {
            subscriptions.delete(targetSessionId);
            subscriptions.set(result.sessionId, {
              channel: result.channel, subscriber: mutable.subscriber,
            });
            mutable.rekey(result.sessionId);
          }

          // Handle rekey from rekeyPromise (pending → real ID)
          if (result.rekeyPromise) {
            result.rekeyPromise
              .then(realId => {
                // Core provenance must always update, even after client disconnect (fix #2)
                if (provenance) {
                  rekeyChildSession(result.sessionId, realId);
                  registeredChildren.delete(result.sessionId);
                  registeredChildren.add(realId);
                }
                if (disposed) return; // transport-only ops below
                mutable.rekey(realId);
                const entry = subscriptions.get(result.sessionId);
                if (entry) {
                  subscriptions.delete(result.sessionId);
                  subscriptions.set(realId, entry);
                }
              })
              .catch(() => {
                subscriptions.delete(result.sessionId);
              });
          }

          return { sessionId: result.sessionId };
        }

        // New-channel paths (new/fork)
        const pendingId = (params.pendingId as string) || `pending:${crypto.randomUUID()}`;
        const mutable = createMutableSubscriber(pendingId);

        // Register provenance before sendTurn so the child is tracked immediately
        if (provenance) {
          registerChildSession(pendingId, provenance);
          registeredChildren.add(pendingId);
        }

        const result = await sendTurn(intent, mutable.subscriber, pendingId);
        subscriptions.set(result.sessionId, {
          channel: result.channel, subscriber: mutable.subscriber,
        });

        // Migrate provenance from pending to resolved ID
        if (provenance && result.sessionId !== pendingId) {
          rekeyChildSession(pendingId, result.sessionId);
          registeredChildren.delete(pendingId);
          registeredChildren.add(result.sessionId);
        }

        // Handle rekey from rekeyPromise (pending → real ID)
        if (result.rekeyPromise) {
          result.rekeyPromise
            .then(realId => {
              // Core provenance must always update, even after client disconnect (fix #2)
              if (provenance) {
                rekeyChildSession(result.sessionId, realId);
                registeredChildren.delete(result.sessionId);
                registeredChildren.add(realId);
              }
              if (disposed) return; // transport-only ops below
              mutable.rekey(realId);
              const entry = subscriptions.get(result.sessionId);
              if (entry) {
                subscriptions.delete(result.sessionId);
                subscriptions.set(realId, entry);
              }
            })
            .catch(() => {
              subscriptions.delete(result.sessionId);
            });
        }

        return { sessionId: result.sessionId };
      }

      case "resolveApproval": {
        const sessionId = params.sessionId as string;
        const toolUseId = params.toolUseId as string;
        const optionId = params.optionId as string;
        const rawExtra = params.extra as Record<string, unknown> | undefined;
        const extra = rawExtra ? {
          message: rawExtra.message as string | undefined,
          updatedInput: rawExtra.updatedInput as Record<string, unknown> | undefined,
          updatedPermissions: rawExtra.updatedPermissions as unknown[] | undefined,
        } : {};
        const sub = subscriptions.get(sessionId);
        if (!sub) {
          throw new Error(
            `Not subscribed to session "${sessionId}". Call subscribe first.`,
          );
        }
        resolveApproval(sub.channel, toolUseId, optionId, extra);
        return { resolved: true };
      }

      case "interrupt": {
        const sessionId = params.sessionId as string;
        await interruptSession(sessionId);
        return { interrupted: true };
      }

      case "close": {
        const sessionId = params.sessionId as string;
        // Clean up our subscription tracking first
        const sub = subscriptions.get(sessionId);
        if (sub) {
          unsubscribe(sub.channel, sub.subscriber);
          subscriptions.delete(sessionId);
        }
        closeSession(sessionId);
        return { closed: true };
      }

      case "dispatchChild": {
        const options = params as unknown as ChildSessionOptions & { logFile?: string };
        const logFile = options.logFile;
        if (logFile) {
          delete (options as unknown as Record<string, unknown>).logFile;
          options.onEntry = (msg) => {
            try {
              const line = formatLogEntry(msg);
              if (line) appendFileSync(logFile, line + '\n', 'utf8');
            } catch { /* best-effort */ }
          };
        }
        return dispatchChildSession(options);
      }

      case "resumeChild": {
        const options = params as unknown as ResumeChildOptions & { logFile?: string };
        const logFile = options.logFile;
        if (logFile) {
          delete (options as unknown as Record<string, unknown>).logFile;
          options.onEntry = (msg) => {
            try {
              const line = formatLogEntry(msg);
              if (line) appendFileSync(logFile, line + '\n', 'utf8');
            } catch { /* best-effort */ }
          };
        }
        return resumeChildSession(options);
      }

      case "subscribeSessionList": {
        if (sessionListSub) return { subscribed: true };
        sessionListSub = {
          id: clientId,
          send(event) {
            sendFn({ kind: "event", sessionId: SESSION_LIST_CHANNEL_ID, event });
          },
        };
        subscribeSessionList(sessionListSub);
        return { subscribed: true };
      }

      case "unsubscribeSessionList": {
        if (sessionListSub) {
          unsubscribeSessionList(sessionListSub);
          sessionListSub = null;
        }
        return { unsubscribed: true };
      }

      case "subscribeLog": {
        if (rosieLogSub) return { subscribed: true };
        rosieLogSub = {
          id: clientId,
          send(event) {
            sendFn({ kind: "event", sessionId: LOG_CHANNEL_ID, event });
          },
        };
        subscribeLog(rosieLogSub);
        return { subscribed: true };
      }

      case "unsubscribeLog": {
        if (rosieLogSub) {
          unsubscribeLog(rosieLogSub);
          rosieLogSub = null;
        }
        return { unsubscribed: true };
      }

      // --- Tracker notification subscription ---
      case "subscribeTrackerNotify": {
        if (trackerNotifySub) return { subscribed: true };
        trackerNotifySub = {
          id: clientId,
          send(event) {
            sendFn({ kind: "event", sessionId: TRACKER_NOTIFY_CHANNEL_ID, event });
          },
        };
        subscribeTrackerNotify(trackerNotifySub);
        return { subscribed: true };
      }

      case "unsubscribeTrackerNotify": {
        if (trackerNotifySub) {
          unsubscribeTrackerNotify(trackerNotifySub);
          trackerNotifySub = null;
        }
        return { unsubscribed: true };
      }

      // --- Recall catch-up subscription (follows subscribeLog pattern) ---
      case "subscribeRecallCatchup": {
        if (catchupSub) return { subscribed: true };
        catchupSub = {
          id: clientId,
          send(event) {
            sendFn({ kind: "event", sessionId: RECALL_CATCHUP_CHANNEL_ID, event });
          },
        };
        subscribeCatchup(catchupSub);
        return { subscribed: true };
      }

      case "unsubscribeRecallCatchup": {
        if (catchupSub) {
          unsubscribeCatchup(catchupSub.id);
          catchupSub = null;
        }
        return { unsubscribed: true };
      }

      case "startEmbeddingBackfill": {
        startEmbeddingBackfill();
        return { ok: true };
      }

      case "stopEmbeddingBackfill": {
        stopEmbeddingBackfill();
        return { ok: true };
      }

      case "getCatchupStatus": {
        return getCatchupStatus();
      }

      case "getGitFiles": {
        const cwd = params.cwd as string;
        return getGitFiles(cwd);
      }

      case "fileExists": {
        const filePath = params.path as string;
        try {
          assertPathAllowed(filePath);
        } catch {
          return false;
        }
        return fileExists(filePath);
      }

      case "readImage": {
        const filePath = params.path as string;
        assertPathAllowed(filePath);
        return readImage(filePath);
      }

      case "readFile": {
        const filePath = params.path as string;
        assertPathAllowed(filePath);
        return readTextFile(filePath);
      }

      case "forkToNewPanel":
        // VS Code intercepts in webview-host; browser handles via window.open()
        return { ok: false };

      case "openFile":
        // VS Code intercepts in webview-host; no-op for dev server
        return { opened: false };

      case "pickFile":
        // VS Code-only QuickPick; no-op for dev server
        return { picked: null };

      case "readSubagentEntries": {
        const sessionId = params.sessionId as string;
        const agentId = params.agentId as string;
        const parentToolUseId = params.parentToolUseId as string;
        const cursor = (params.cursor as string) ?? '';
        return readSubagentEntries(sessionId, agentId, parentToolUseId, cursor);
      }

      case 'getSettings':
        return getSettingsSnapshot();

      case 'updateSettings': {
        const patch = params.patch as SettingsPatch;
        const expectedRevision = params.expectedRevision as number | undefined;
        return updateSettings(patch, { expectedRevision });
      }

      case 'listProviders':
        return getSettingsSnapshot().settings.providers;

      case 'saveProvider': {
        const slug = params.slug as string;
        const config = params.config as ProviderConfig;
        await updateSettings({ providers: { [slug]: config } });
        return { saved: true };
      }

      case 'deleteProvider': {
        const slug = params.slug as string;
        await deleteProvider(slug);
        return { deleted: true };
      }

      case 'getModelGroups':
        return await getModelGroups(getRegisteredVendors());

      case "getActivityLog": {
        const from = params.from as string | undefined;
        const to = params.to as string | undefined;
        const projectSlug = params.projectSlug as string | undefined;

        // Convert project slug to file path prefix for filtering
        let filePrefix: string | undefined;
        if (projectSlug) {
          filePrefix = resolve(homedir(), '.claude', 'projects', projectSlug);
        }

        return queryActivity(
          from || to ? { from, to } : undefined,
          'prompt',
          filePrefix,
        );
      }

      case "getResponsePreview": {
        const file = params.file as string;
        const offset = params.offset as number;
        // Route to correct vendor reader based on file path
        if (file.includes('/.codex/') || file.includes('/codex/')) {
          return readCodexResponsePreview(file, offset);
        }
        return readResponsePreview(file, offset);
      }

      case "getSessionLineage": {
        const filePath = params.file as string;
        return getLineage(filePath);
      }

      case "getSessionChildren": {
        const filePath = params.file as string;
        return getChildSessions(filePath);
      }

      case "getLineageGraph": {
        return getLineageGraph();
      }

      case "transcribeAudio": {
        const audioBase64 = params.audioBase64 as string;
        const sampleRate = params.sampleRate as number;

        // Decode base64 → Float32Array
        const binary = Buffer.from(audioBase64, 'base64');
        log({
          source: 'voice',
          level: 'info',
          summary: `RPC transcribeAudio received: ${binary.byteLength} bytes, sampleRate=${sampleRate}, base64 length=${audioBase64.length}`,
        });
        if (binary.byteLength % 4 !== 0) {
          throw new Error(`Audio buffer length ${binary.byteLength} is not aligned to 4 bytes`);
        }
        const pcmFloat32 = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / 4);
        log({
          source: 'voice',
          level: 'info',
          summary: `Decoded ${pcmFloat32.length} samples (${(pcmFloat32.length / sampleRate).toFixed(1)}s), calling transcribeAudio...`,
        });

        const { transcribeAudio } = await import('../core/voice/index.js');
        const result = await transcribeAudio(pcmFloat32, sampleRate);
        log({
          source: 'voice',
          level: 'info',
          summary: `transcribeAudio result: ${result.segments} segments, ${result.durationMs}ms, text="${result.text.slice(0, 80)}"`,
        });
        return { text: result.text };
      }

      case "startVoiceCapture": {
        await startCapture();
        return { started: true };
      }

      case "stopVoiceCapture": {
        const captured = await stopCapture();

        log({
          source: 'voice',
          level: 'info',
          summary: `Host capture: ${captured.pcmFloat32.length} samples (${(captured.pcmFloat32.length / captured.sampleRate).toFixed(1)}s), running transcription...`,
        });

        const { transcribeAudio: transcribe } = await import('../core/voice/index.js');
        const txResult = await transcribe(captured.pcmFloat32, captured.sampleRate);
        log({
          source: 'voice',
          level: 'info',
          summary: `Host capture transcription: ${txResult.segments} segments, ${txResult.durationMs}ms, text="${txResult.text.slice(0, 80)}"`,
        });
        return { text: txResult.text };
      }

      case "getProjects": {
        const rawProjects = getProjectsWithDetails();
        // Enrich session file paths with display data from the session list cache
        const allSessions = listAllSessions();
        const sessionMap = new Map(allSessions.map(s => [s.path, s]));

        return rawProjects.map(p => {
            const sessions = p.sessionFiles
              .map(file => {
                const info = sessionMap.get(file);
                if (!info) return null;
                return {
                  sessionId: info.sessionId,
                  sessionFile: file,
                  // NOTE: duplicates getSessionDisplayName() logic from webview — can't import across layer boundary
                  title: info.title?.trim() || info.label?.trim() || info.sessionId.slice(0, 8) + '\u2026',
                  preview: info.lastMessage || undefined,
                  modifiedAt: info.modifiedAt instanceof Date ? info.modifiedAt.toISOString() : String(info.modifiedAt),
                };
              })
              .filter((s): s is NonNullable<typeof s> => s !== null);

            // Origin session = first session (sessions are ordered by linked_at ASC)
            const originSessionTitle = sessions.length > 0 ? sessions[0]!.title : undefined;

            return {
              id: p.id,
              title: p.title,
              stage: p.stage,
              status: p.status || undefined,
              icon: p.icon || undefined,
              sortOrder: p.sortOrder ?? undefined,
              blockedBy: p.blockedBy || undefined,
              summary: p.summary || undefined,
              branch: p.branch || undefined,
              createdAt: p.createdAt,
              closedAt: p.closedAt || undefined,
              lastActivityAt: p.lastActivityAt || new Date().toISOString(),
              sessionCount: sessions.length,
              originSessionTitle,
              files: p.files.map(f => ({ path: f.path, note: f.note || undefined })),
              sessions,
            };
          });
      }

      case "getProjectActivity": {
        const { projectId, kind } = params as { projectId: string; kind?: string };
        return getProjectActivity(projectId, kind ? { kind } : undefined);
      }

      case "getStages":
        return getStages();

      case "updateProjectStage": {
        const { projectId: stageProjectId, stage } = params as { projectId: string; stage: string };
        if (!getValidStageNames().includes(stage)) throw new Error(`Invalid stage: ${stage}`);
        updateProjectStage(stageProjectId, stage);
        return { ok: true };
      }

      case "createProject": {
        const projectId = randomUUID();
        // Resolve session file: prefer explicit param, fall back to looking up
        // parentSessionId (the session being tracked) or sessionId (caller)
        let sessionFile = (params.sessionFile as string) || '';
        if (!sessionFile) {
          const lookupId = (params.parentSessionId as string) || (params.sessionId as string);
          if (lookupId) {
            const match = listAllSessions().find(s => s.sessionId === lookupId);
            if (match) sessionFile = match.path;
          }
        }
        const block: TrackerBlock = {
          project: {
            action: 'create',
            id: projectId,
            title: params.title as string,
            type: (params.type as 'project' | 'task' | 'idea') ?? 'project',
            stage: params.stage as string,
            status: params.status as string,
            summary: params.summary as string,
            icon: params.icon as string,
            blocked_by: (params.blocked_by as string) ?? '',
            branch: (params.branch as string) ?? '',
            parent_id: params.parent_id as string | undefined,
          },
          sessionRef: { detected_in: '' },
          files: [],
        };
        writeTrackerResults([block], sessionFile);
        pushTrackerNotification({
          kind: 'project_created',
          projectTitle: params.title as string,
          icon: params.icon as string | undefined,
          newStage: params.stage as string,
          status: params.status as string | undefined,
        });
        return { status: 'ok', projectId };
      }

      case "trackProject": {
        const projectId = params.projectId as string;
        // Resolve session file: prefer explicit param, fall back to looking up
        // parentSessionId (the session being tracked) or sessionId (caller)
        let trackSessionFile = (params.sessionFile as string) || '';
        if (!trackSessionFile) {
          const lookupId = (params.parentSessionId as string) || (params.sessionId as string);
          if (lookupId) {
            const match = listAllSessions().find(s => s.sessionId === lookupId);
            if (match) trackSessionFile = match.path;
          }
        }
        const block: TrackerBlock = {
          project: {
            action: 'track',
            id: projectId,
            status: params.status as string,
            stage: params.stage as string | undefined,
            blocked_by: params.blocked_by as string | undefined,
            branch: params.branch as string | undefined,
          },
          sessionRef: { detected_in: '' },
          files: [],
        };
        writeTrackerResults([block], trackSessionFile);
        const trackInfo = getProjectTitle(projectId);
        pushTrackerNotification({
          kind: params.stage ? 'stage_change' : 'project_matched',
          projectTitle: trackInfo?.title,
          icon: trackInfo?.icon,
          newStage: params.stage as string | undefined,
          status: params.status as string | undefined,
        });
        return { status: 'ok', projectId };
      }

      case "mergeProject": {
        const keepId = params.keepId as string;
        const removeId = params.removeId as string;
        const keepInfo = getProjectTitle(keepId);
        mergeProjects(keepId, removeId);
        pushTrackerNotification({
          kind: 'project_matched',
          projectTitle: keepInfo?.title,
          status: `Merged duplicate (removed ${removeId.slice(0, 8)}…)`,
        });
        return { status: 'ok', keepId, removeId };
      }

      case "markTrivial": {
        const reason = params.reason as string;
        pushTrackerNotification({
          kind: 'trivial',
          status: reason,
        });
        return { status: 'ok', reason };
      }

      case "getProjectDetails": {
        const projectId = params.projectId as string;
        const db = getDb(dbPath());
        const row = db.get(
          `SELECT id, type, stage, parent_id, title, status, summary, icon, branch, blocked_by, created_at, updated_at
           FROM projects WHERE id = ?`,
          [projectId],
        );
        return row || { error: 'not found' };
      }

      case "setSessionTitle": {
        const sessionId = params.sessionId as string;
        const title = params.title as string;
        setSessionTitle(sessionId, title);
        refreshAndNotify(sessionId);
        return { status: 'ok', sessionId };
      }

      case "updateProjectSortOrder": {
        const { updates } = params as { updates: Array<{ id: string; sortOrder: number }> };
        for (const u of updates) {
          updateProjectSortOrder(u.id, u.sortOrder);
        }
        return { ok: true };
      }

      case "resolveSessionId": {
        const { sessionId } = params as { sessionId: string };
        return { sessionId: resolveSessionId(sessionId) };
      }

      case "resolveSessionPrefix": {
        const { sessionId } = params as { sessionId: string };
        return { sessionId: resolveSessionPrefix(sessionId) };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  function dispose(): void {
    disposed = true;
    cancelCapture(); // idempotent — no-ops if not recording
    settingsUnsub();
    if (sessionListSub) {
      unsubscribeSessionList(sessionListSub);
      sessionListSub = null;
    }
    if (rosieLogSub) {
      unsubscribeLog(rosieLogSub);
      rosieLogSub = null;
    }
    if (trackerNotifySub) {
      unsubscribeTrackerNotify(trackerNotifySub);
      trackerNotifySub = null;
    }
    if (catchupSub) {
      unsubscribeCatchup(catchupSub.id);
      catchupSub = null;
    }
    for (const [, sub] of subscriptions) {
      try {
        unsubscribe(sub.channel, sub.subscriber);
      } catch {
        // Best-effort cleanup
      }
    }
    subscriptions.clear();

    // Close child sessions registered via provenance (fix #7: prevent memory leak)
    for (const childId of registeredChildren) {
      try {
        closeSession(childId);
      } catch {
        // Best-effort — session may already be closed
      }
    }
    registeredChildren.clear();
  }

  return {
    handleMessage,
    call,
    addAllowedRoot(absolutePath: string) {
      extraAllowedRoots.add(resolve(absolutePath));
    },
    dispose,
  };
}
