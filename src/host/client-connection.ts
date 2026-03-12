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

import { resolve } from "node:path";
import { homedir } from "node:os";
import type { TurnIntent } from "../core/agent-adapter.js";
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
} from "../core/session-manager.js";
import type { ChildSessionOptions, ResumeChildOptions } from "../core/session-manager.js";
import {
  subscribeSessionList,
  unsubscribeSessionList,
  type SessionListSubscriber,
} from "../core/session-list-manager.js";
import { SESSION_LIST_CHANNEL_ID } from "../core/session-list-events.js";
import {
  subscribeRosieLog,
  unsubscribeRosieLog,
  ROSIE_LOG_CHANNEL_ID,
  pushRosieLog,
} from "../core/rosie/debug-log.js";
import type { RosieLogEvent, RosieLogSubscriber } from "../core/rosie/debug-log.js";
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
import { getGitFiles, fileExists, readImage, readTextFile } from "../core/file-service.js";
import { queryActivity, getLineage, getChildSessions, getLineageGraph } from '../core/activity-index.js';
import { readResponsePreview } from '../core/adapters/claude/jsonl-reader.js';
import { readCodexResponsePreview } from '../core/adapters/codex/codex-jsonl-reader.js';
// Voice module is lazy-loaded to avoid pulling onnxruntime-node native bindings
// at extension activation time (crashes VS Code's Electron host).
// import { transcribeAudio } from '../core/voice/index.js'; // <-- lazy below
import { startCapture, stopCapture, cancelCapture, cleanupOrphanedVoiceFiles } from './audio-capture.js';

// Clean up any orphaned voice temp files from previous sessions on module load.
cleanupOrphanedVoiceFiles();

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
  const normalizedRoot = root.endsWith('/') ? root : root + '/';
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
export type HostEvent = SubscriberMessage | SessionListEvent | SettingsChangedGlobalEvent | RosieLogEvent | RecallCatchupEvent;

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
  let rosieLogSub: RosieLogSubscriber | null = null;

  /** Global recall catch-up subscription for this client. */
  let catchupSub: CatchupSubscriber | null = null;

  /** Flag set on dispose() to prevent re-keying after client disconnect. */
  let disposed = false;

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

      case "subscribe": {
        const sessionId = params.sessionId as string;

        // Already subscribed — resend catchup so the client can resync
        // after a pending→real handoff or listener race without creating
        // a duplicate subscriber.
        const existing = subscriptions.get(sessionId);
        if (existing) {
          const entries = await loadSession(sessionId);
          subscribe(existing.channel, existing.subscriber, entries);
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
                if (disposed) return;
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
        const pendingId = `pending:${crypto.randomUUID()}`;
        const mutable = createMutableSubscriber(pendingId);
        const result = await sendTurn(intent, mutable.subscriber, pendingId);
        subscriptions.set(result.sessionId, {
          channel: result.channel, subscriber: mutable.subscriber,
        });

        // Handle rekey from rekeyPromise (pending → real ID)
        if (result.rekeyPromise) {
          result.rekeyPromise
            .then(realId => {
              if (disposed) return;
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
        const options = params as unknown as ChildSessionOptions;
        return dispatchChildSession(options);
      }

      case "resumeChild": {
        const options = params as unknown as ResumeChildOptions;
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

      case "subscribeRosieLog": {
        if (rosieLogSub) return { subscribed: true };
        rosieLogSub = {
          id: clientId,
          send(event) {
            sendFn({ kind: "event", sessionId: ROSIE_LOG_CHANNEL_ID, event });
          },
        };
        subscribeRosieLog(rosieLogSub);
        return { subscribed: true };
      }

      case "unsubscribeRosieLog": {
        if (rosieLogSub) {
          unsubscribeRosieLog(rosieLogSub);
          rosieLogSub = null;
        }
        return { unsubscribed: true };
      }

      // --- Recall catch-up subscription (follows subscribeRosieLog pattern) ---
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
        return getModelGroups(getRegisteredVendors());

      case "getActivityLog": {
        const from = params.from as string | undefined;
        const to = params.to as string | undefined;
        const kind = (params.kind as string | undefined) ?? 'prompt';
        const projectSlug = params.projectSlug as string | undefined;

        // Convert project slug to file path prefix for filtering
        let filePrefix: string | undefined;
        if (projectSlug) {
          filePrefix = resolve(homedir(), '.claude', 'projects', projectSlug);
        }

        return queryActivity(
          from || to ? { from, to } : undefined,
          kind as 'prompt' | 'rosie-meta',
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
        pushRosieLog({
          source: 'voice',
          level: 'info',
          summary: `RPC transcribeAudio received: ${binary.byteLength} bytes, sampleRate=${sampleRate}, base64 length=${audioBase64.length}`,
        });
        if (binary.byteLength % 4 !== 0) {
          throw new Error(`Audio buffer length ${binary.byteLength} is not aligned to 4 bytes`);
        }
        const pcmFloat32 = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / 4);
        pushRosieLog({
          source: 'voice',
          level: 'info',
          summary: `Decoded ${pcmFloat32.length} samples (${(pcmFloat32.length / sampleRate).toFixed(1)}s), calling transcribeAudio...`,
        });

        const { transcribeAudio } = await import('../core/voice/index.js');
        const result = await transcribeAudio(pcmFloat32, sampleRate);
        pushRosieLog({
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

        pushRosieLog({
          source: 'voice',
          level: 'info',
          summary: `Host capture: ${captured.pcmFloat32.length} samples (${(captured.pcmFloat32.length / captured.sampleRate).toFixed(1)}s), running transcription...`,
        });

        const { transcribeAudio: transcribe } = await import('../core/voice/index.js');
        const txResult = await transcribe(captured.pcmFloat32, captured.sampleRate);
        pushRosieLog({
          source: 'voice',
          level: 'info',
          summary: `Host capture transcription: ${txResult.segments} segments, ${txResult.durationMs}ms, text="${txResult.text.slice(0, 80)}"`,
        });
        return { text: txResult.text };
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
      unsubscribeRosieLog(rosieLogSub);
      rosieLogSub = null;
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
  }

  return { handleMessage, call, dispose };
}
