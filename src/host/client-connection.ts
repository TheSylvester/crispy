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

import type { MessageContent, Vendor } from "../core/transcript.js";
import type { SendOptions } from "../core/agent-adapter.js";
import type {
  Subscriber,
  SubscriberEvent,
  SessionChannel,
} from "../core/session-channel.js";
import type { SessionListEvent } from "../core/session-list-events.js";
import { resolveApproval, unsubscribe } from "../core/session-channel.js";
import {
  listAllSessions,
  findSession,
  loadSession,
  subscribeSession,
  createSession,
  sendToSession,
  setSessionModel,
  setSessionPermissions,
  interruptSession,
  closeSession,
} from "../core/session-manager.js";
import {
  subscribeSessionList,
  unsubscribeSessionList,
  type SessionListSubscriber,
} from "../core/session-list-manager.js";
import { SESSION_LIST_CHANNEL_ID } from "../core/session-list-events.js";

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
export type HostEvent = SubscriberEvent | SessionListEvent;

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
        return loadSession(params.sessionId as string);

      case "subscribe": {
        const sessionId = params.sessionId as string;

        // Don't double-subscribe
        if (subscriptions.has(sessionId)) {
          return { subscribed: true };
        }

        const subscriber: Subscriber = {
          id: clientId,
          send(event: SubscriberEvent) {
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

      case "createSession": {
        const vendor = (params.vendor as string) ?? 'claude';
        const cwdParam = params.cwd as string;
        const model = params.model as string | undefined;
        const permissionMode = params.permissionMode as string | undefined;

        let currentSessionId = '';

        const subscriber: Subscriber = {
          id: clientId,
          send(event: SubscriberEvent) {
            sendFn({ kind: "event", sessionId: currentSessionId, event });
            // Re-key subscription tracking on session_changed
            if (
              event.type === 'notification' &&
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

        const { pendingId, channel } = createSession(
          vendor as Vendor, cwdParam, subscriber,
          { model, permissionMode: permissionMode as SendOptions['permissionMode'] },
        );
        currentSessionId = pendingId;
        subscriptions.set(pendingId, { channel, subscriber });
        return { pendingId };
      }

      case "send": {
        const sessionId = params.sessionId as string;
        const content = params.content as MessageContent;
        const options = params.options as Record<string, unknown> | undefined;
        sendToSession(sessionId, content, options);
        return { sent: true };
      }

      case "resolveApproval": {
        const sessionId = params.sessionId as string;
        const toolUseId = params.toolUseId as string;
        const optionId = params.optionId as string;
        const extra = {
          message: params.message as string | undefined,
          updatedInput: params.updatedInput as Record<string, unknown> | undefined,
          updatedPermissions: params.updatedPermissions as unknown[] | undefined,
        };
        const sub = subscriptions.get(sessionId);
        if (!sub) {
          throw new Error(
            `Not subscribed to session "${sessionId}". Call subscribe first.`,
          );
        }
        resolveApproval(sub.channel, toolUseId, optionId, extra);
        return { resolved: true };
      }

      case "setModel": {
        const sessionId = params.sessionId as string;
        const model = params.model as string | undefined;
        await setSessionModel(sessionId, model);
        return { set: true };
      }

      case "setPermissions": {
        const sessionId = params.sessionId as string;
        const mode = params.mode as string;
        await setSessionPermissions(sessionId, mode);
        return { set: true };
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

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  function dispose(): void {
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
