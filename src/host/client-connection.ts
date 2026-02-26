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
import type { ChannelMessage, TurnIntent } from "../core/agent-adapter.js";
import type {
  ChannelCatchupMessage,
  HistoryMessage,
} from "../core/channel-events.js";
import type {
  Subscriber,
  SessionChannel,
} from "../core/session-channel.js";
import type { SessionListEvent } from "../core/session-list-events.js";
import type { ProviderEvent } from '../core/provider-events.js';
import { PROVIDERS_CHANNEL_ID } from '../core/provider-events.js';
import { resolveApproval, unsubscribe, getChannel } from "../core/session-channel.js";
import {
  listAllSessions,
  findSession,
  loadSession,
  subscribeSession,
  sendTurn,
  interruptSession,
  closeSession,
  readSubagentEntries,
  continueInVendor,
  getRegisteredVendors,
} from "../core/session-manager.js";
import {
  subscribeSessionList,
  unsubscribeSessionList,
  type SessionListSubscriber,
} from "../core/session-list-manager.js";
import { SESSION_LIST_CHANNEL_ID } from "../core/session-list-events.js";
import { getGitFiles, fileExists, readImage, readTextFile } from "../core/file-service.js";
import {
  getProviders, saveProvider, deleteProvider, getModelGroups,
  onProvidersChanged, getProviderBase,
} from '../core/provider-config.js';
import type { ProviderConfig } from '../core/provider-config.js';

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
export type HostEvent = ChannelMessage | HistoryMessage | ChannelCatchupMessage | SessionListEvent | ProviderEvent;

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

  /** Push model group updates when providers.json changes. */
  const providerUnsub = onProvidersChanged(() => {
    sendFn({
      kind: 'event',
      sessionId: PROVIDERS_CHANNEL_ID,
      event: { type: 'providers_changed', groups: getModelGroups(getRegisteredVendors()) },
    });
  });

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
      const result = await routeMethod(method, params ?? {});
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

        // Don't double-subscribe
        if (subscriptions.has(sessionId)) {
          return { subscribed: true };
        }

        const subscriber: Subscriber = {
          id: clientId,
          send(event: ChannelMessage | HistoryMessage | ChannelCatchupMessage) {
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

        // For existing sessions, use the already-subscribed subscriber
        if (intent.target.kind === 'existing') {
          const sessionId = intent.target.sessionId;
          const sub = subscriptions.get(sessionId);
          if (!sub) {
            throw new Error(
              `Not subscribed to session "${sessionId}". Call subscribe first.`
            );
          }
          return await sendTurn(intent, sub.subscriber);
        }

        // Generate pending ID here so currentSessionId is set before
        // sendTurn broadcasts the user entry (which triggers subscriber.send).
        const pendingId = `pending:${crypto.randomUUID()}`;
        let currentSessionId = pendingId;

        const subscriber: Subscriber = {
          id: clientId,
          send(event: ChannelMessage | HistoryMessage | ChannelCatchupMessage) {
            sendFn({ kind: "event", sessionId: currentSessionId, event });
            // Re-key subscription tracking on session_changed
            if (
              event.type === 'event' &&
              event.event.type === 'notification' &&
              event.event.kind === 'session_changed' &&
              event.event.sessionId
            ) {
              const realId = event.event.sessionId;
              const sub = subscriptions.get(currentSessionId);
              if (sub) {
                subscriptions.delete(currentSessionId);
                currentSessionId = realId;
                subscriptions.set(realId, sub);
              }
            }
          },
        };

        const receipt = await sendTurn(intent, subscriber, pendingId);

        // For new/fork, sendTurn() internally calls createSession/createForkSession
        // which returns the channel. We need to track it for cleanup.
        const channel = getChannel(receipt.sessionId);
        if (channel) {
          subscriptions.set(receipt.sessionId, { channel, subscriber });
        }

        return receipt;
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

      case 'listProviders':
        return getProviders();

      case 'saveProvider': {
        const slug = params.slug as string;
        const config = params.config as ProviderConfig;
        await saveProvider(slug, config, getProviderBase());
        return { saved: true };
      }

      case 'deleteProvider': {
        const slug = params.slug as string;
        await deleteProvider(slug, getProviderBase());
        return { deleted: true };
      }

      case 'getModelGroups':
        return getModelGroups(getRegisteredVendors());

      case "continueInVendor": {
        const sourceSessionId = params.sourceSessionId as string;
        const targetVendor = params.targetVendor as string;
        const model = params.model as string | undefined;
        const permissionMode = params.permissionMode as string | undefined;

        const pendingId = `pending:${crypto.randomUUID()}`;
        let currentSessionId = pendingId;

        const subscriber: Subscriber = {
          id: clientId,
          send(event: ChannelMessage | HistoryMessage | ChannelCatchupMessage) {
            sendFn({ kind: "event", sessionId: currentSessionId, event });
            // Re-key on session_changed (same pattern as sendTurn new/fork)
            if (
              event.type === 'event' &&
              event.event.type === 'notification' &&
              event.event.kind === 'session_changed' &&
              event.event.sessionId
            ) {
              const realId = event.event.sessionId;
              const sub = subscriptions.get(currentSessionId);
              if (sub) {
                subscriptions.delete(currentSessionId);
                currentSessionId = realId;
                subscriptions.set(realId, sub);
              }
            }
          },
        };

        const result = await continueInVendor(sourceSessionId, targetVendor, subscriber, {
          ...(model && { model }),
          ...(permissionMode && { permissionMode: permissionMode as any }),
        }, pendingId);

        const channel = getChannel(result.pendingId);
        if (channel) {
          subscriptions.set(result.pendingId, { channel, subscriber });
        }
        return { sessionId: result.pendingId };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  function dispose(): void {
    providerUnsub();
    if (sessionListSub) {
      unsubscribeSessionList(sessionListSub);
      sessionListSub = null;
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

  return { handleMessage, dispose };
}
