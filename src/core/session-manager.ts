/**
 * Session Manager — Cross-Vendor Orchestration Layer
 *
 * The entry point for vendor-agnostic session operations. Maintains a
 * registry of vendor adapters and provides session-ID-keyed operations
 * across all of them.
 *
 * Two registries:
 * - adapters: Map<Vendor, VendorRegistration> — discovery + factory per vendor
 * - sessions: Map<string, SessionChannel> — live channels keyed by sessionId
 *
 * Design matches session-channel.ts: functional API with module-level state.
 *
 * Ownership model: each vendor registers a VendorDiscovery object for
 * stateless ops (listSessions, findSession, loadHistory) and a factory
 * that creates a fresh AgentAdapter per live session. Each channel owns
 * its adapter exclusively, so multiple live sessions per vendor are supported.
 *
 * @module session-manager
 */

import type { AgentAdapter, VendorDiscovery, SessionInfo, SendOptions, SessionOpenSpec, ChannelMessage, TurnIntent, TurnReceipt, TurnSettings } from './agent-adapter.js';
import type { TranscriptEntry, Vendor, MessageContent } from './transcript.js';
import type { ChannelCatchupMessage, HistoryMessage } from './channel-events.js';
import type { SessionChannel, Subscriber } from './session-channel.js';

import {
  createChannel, setAdapter, subscribe, unsubscribe,
  sendMessage, destroyChannel, backfillHistory, rekeyChannel,
  broadcastUserEntry as channelBroadcastUserEntry,
} from './session-channel.js';
import { refreshAndNotify } from './session-list-manager.js';

/** Type for all messages a subscriber can receive. */
type SubscriberMessage = ChannelMessage | HistoryMessage | ChannelCatchupMessage;

/** Type guard for session_changed notification events. */
function isSessionChangedEvent(msg: SubscriberMessage): msg is ChannelMessage & { type: 'event'; event: { type: 'notification'; kind: 'session_changed'; sessionId: string } } {
  return (
    msg.type === 'event' &&
    msg.event.type === 'notification' &&
    msg.event.kind === 'session_changed' &&
    'sessionId' in msg.event &&
    typeof msg.event.sessionId === 'string'
  );
}

// ============================================================================
// Types
// ============================================================================

/** Registration entry: static discovery + factory for per-session adapters. */
export interface VendorRegistration {
  discovery: VendorDiscovery;
  createAdapter: (spec: SessionOpenSpec) => AgentAdapter;
}

// ============================================================================
// Registries
// ============================================================================

/** Discovery + factory per vendor. */
const adapters = new Map<Vendor, VendorRegistration>();

/** Live channels keyed by sessionId. */
const sessions = new Map<string, SessionChannel>();

/** In-flight channel initialization promises — guards concurrent subscribeSession(). */
const pending = new Map<string, Promise<SessionChannel>>();

// ============================================================================
// Adapter Registry
// ============================================================================

/**
 * Register a vendor's discovery object and per-session adapter factory.
 * Throws if an adapter for that vendor is already registered.
 */
export function registerAdapter(
  discovery: VendorDiscovery,
  createAdapter: (spec: SessionOpenSpec) => AgentAdapter,
): void {
  if (adapters.has(discovery.vendor)) {
    throw new Error(
      `Adapter for vendor "${discovery.vendor}" is already registered. ` +
      `Call unregisterAdapter("${discovery.vendor}") first.`
    );
  }
  adapters.set(discovery.vendor, { discovery, createAdapter });
}

/**
 * Unregister the adapter for a vendor.
 * Closes any live sessions using that adapter before removing it,
 * preventing orphaned channels with a dangling adapter reference.
 * No-op if not registered.
 */
export function unregisterAdapter(vendor: Vendor): void {
  if (!adapters.has(vendor)) return;

  // Collect IDs first to avoid mutating sessions during iteration
  const toClose = [...sessions.entries()]
    .filter(([, ch]) => ch.adapter?.vendor === vendor)
    .map(([id]) => id);

  for (const sessionId of toClose) {
    destroyChannel(sessionId);
    sessions.delete(sessionId);
  }

  adapters.delete(vendor);
}

/** Get the discovery object for a specific vendor. */
export function getDiscovery(vendor: Vendor): VendorDiscovery | undefined {
  return adapters.get(vendor)?.discovery;
}

/** Get all registered discovery objects. */
export function getDiscoveries(): VendorDiscovery[] {
  return [...adapters.values()].map((r) => r.discovery);
}

/**
 * Test helper — clears both registries.
 * Destroys all live channels before clearing.
 */
export function _resetRegistry(): void {
  for (const [sessionId] of sessions) {
    destroyChannel(sessionId);
  }
  sessions.clear();
  pending.clear();
  adapters.clear();
}

// ============================================================================
// Cross-Vendor Discovery
// ============================================================================

/**
 * Find a session by ID across all registered adapters.
 * Iterates adapters until one claims the session.
 */
export function findSession(sessionId: string): SessionInfo | undefined {
  for (const { discovery } of adapters.values()) {
    const info = discovery.findSession(sessionId);
    if (info) return info;
  }
  return undefined;
}

/**
 * Load transcript entries for a session (read-only).
 *
 * Identifies the owning vendor via findSession(), then delegates to
 * that adapter's loadHistory(). Does NOT create a channel.
 *
 * Returns [] if the session is not found across any vendor.
 */
export async function loadSession(
  sessionId: string,
  options?: { until?: string },
): Promise<TranscriptEntry[]> {
  const info = findSession(sessionId);
  if (!info) return [];

  const reg = adapters.get(info.vendor);
  if (!reg) return [];

  const entries = await reg.discovery.loadHistory(sessionId);
  if (options?.until) {
    const cutIdx = entries.findIndex(e => e.uuid === options.until);
    if (cutIdx !== -1) return entries.slice(0, cutIdx + 1);
  }
  return entries;
}

/**
 * Aggregate all sessions from all registered adapters.
 * Sorted by modifiedAt descending (most recent first).
 */
export function listAllSessions(): SessionInfo[] {
  const all: SessionInfo[] = [];
  for (const { discovery } of adapters.values()) {
    all.push(...discovery.listSessions());
  }
  return all.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Look up an open channel by sessionId.
 * Throws if no channel exists — caller must subscribeSession() first.
 */
function requireChannel(sessionId: string): SessionChannel {
  const channel = sessions.get(sessionId);
  if (!channel) {
    throw new Error(
      `No open channel for session "${sessionId}". Call subscribeSession() first.`
    );
  }
  return channel;
}

/**
 * Evict a dead channel from the sessions map.
 *
 * Channels that have transitioned to 'unattached' (stream exhausted,
 * adapter closed, or error) are terminal — the tearing flag is permanent
 * and the consumption loop cannot be restarted. Evict them so
 * subscribeSession() can create a fresh channel.
 */
function evictIfDead(sessionId: string): void {
  const channel = sessions.get(sessionId);
  if (channel && channel.state === 'unattached') {
    destroyChannel(sessionId);
    sessions.delete(sessionId);
  }
}

/**
 * Create a channel for a session using a factory-created adapter.
 * Internal — not exported. Uses sessionId as channelId (1:1 mapping).
 *
 * Each channel gets its own adapter instance from the vendor's factory,
 * so multiple live sessions per vendor are fully supported.
 */
function openChannel(channelId: string, vendor: Vendor, spec: SessionOpenSpec): SessionChannel {
  const registration = adapters.get(vendor);
  if (!registration) {
    throw new Error(`No adapter registered for vendor "${vendor}".`);
  }

  const liveAdapter = registration.createAdapter(spec);
  const channel = createChannel(channelId);

  // Wire idle hook: when the channel transitions to idle (end of turn),
  // re-read session metadata from disk and push an upsert to all
  // session-list subscribers (title/lastMessage/timestamp may have changed).
  channel.onIdle = () => {
    const sessionId = channel.adapter?.sessionId;
    if (!sessionId) return;
    // Small grace period: the adapter emits idle synchronously when the SDK
    // yields the result message, but the SDK may not have flushed the JSONL
    // file to disk yet. 150ms is enough for the OS write buffer to flush.
    // The 30s rescan is a fallback either way.
    setTimeout(() => refreshAndNotify(sessionId), 150);
  };

  setAdapter(channel, liveAdapter);
  return channel;
}

// ============================================================================
// Session-Keyed Live Operations
// ============================================================================

/**
 * Subscribe to a session's live channel.
 *
 * - Evicts dead (unattached) channels so stale entries don't block reopening.
 * - If no channel exists for this sessionId, one is created:
 *   findSession() identifies the vendor, openChannel() wires the adapter,
 *   loadHistory() backfills transcript entries for the subscriber.
 * - Adds the subscriber to the channel.
 * - Returns the channel.
 *
 * Throws if the session is not found across any registered vendor.
 */
export async function subscribeSession(
  sessionId: string,
  subscriber: Subscriber,
): Promise<SessionChannel> {
  // Evict dead channels so we don't reuse terminal state
  evictIfDead(sessionId);

  // If another call is already initializing this session, wait for it
  const inflight = pending.get(sessionId);
  if (inflight) {
    const channel = await inflight;
    subscribe(channel, subscriber);
    return channel;
  }

  let channel = sessions.get(sessionId);

  if (!channel) {
    // Create a promise for initialization so concurrent callers coalesce
    const init = (async (): Promise<SessionChannel> => {
      const info = findSession(sessionId);
      if (!info) {
        throw new Error(
          `Session "${sessionId}" not found across any registered vendor.`
        );
      }

      const ch = openChannel(sessionId, info.vendor, { mode: 'resume', sessionId });
      sessions.set(sessionId, ch);

      // Backfill transcript history for subscribers.
      // If this fails, clean up the partially-initialized channel
      // so the next caller gets a clean slate, not a poisoned entry.
      try {
        const reg = adapters.get(info.vendor)!;
        const entries = await reg.discovery.loadHistory(sessionId);
        backfillHistory(ch, entries);
      } catch (err) {
        destroyChannel(sessionId);
        sessions.delete(sessionId);
        throw err;
      }

      return ch;
    })();

    pending.set(sessionId, init);
    try {
      channel = await init;
    } finally {
      pending.delete(sessionId);
    }
  }

  subscribe(channel, subscriber);
  return channel;
}

/**
 * Create a brand-new session (no resume ID).
 *
 * Registers the channel under a temporary `pending:<uuid>` key. A one-shot
 * internal subscriber watches for `session_changed` and re-keys to the real
 * session ID in both the channel registry and the sessions map.
 *
 * Returns the pendingId and channel so the caller can track the transition.
 */
export function createSession(
  vendor: Vendor,
  cwd: string,
  subscriber: Subscriber,
  options?: { model?: string; permissionMode?: SendOptions['permissionMode']; extraArgs?: Record<string, string | null> },
  explicitPendingId?: string,
): { pendingId: string; channel: SessionChannel } {
  const registration = adapters.get(vendor);
  if (!registration) throw new Error(`No adapter registered for vendor "${vendor}".`);

  const pendingId = explicitPendingId ?? `pending:${crypto.randomUUID()}`;
  const spec: SessionOpenSpec = {
    mode: 'fresh',
    cwd,
    ...(options?.model && { model: options.model }),
    ...(options?.permissionMode && { permissionMode: options.permissionMode }),
    ...(options?.extraArgs && { extraArgs: options.extraArgs }),
  };

  const channel = openChannel(pendingId, vendor, spec);
  sessions.set(pendingId, channel);
  subscribe(channel, subscriber);

  // One-shot session-list notifier: pushes upsert when the real session ID resolves
  const listNotifySubscriber: Subscriber = {
    id: `__list_notify__${pendingId}`,
    send(msg) {
      if (isSessionChangedEvent(msg)) {
        refreshAndNotify(msg.event.sessionId);
        unsubscribe(channel, listNotifySubscriber);
      }
    },
  };
  subscribe(channel, listNotifySubscriber);

  // One-shot re-key subscriber: swaps pending → real ID on session_changed
  const rekeySubscriber: Subscriber = {
    id: `__rekey__${pendingId}`,
    send(msg) {
      if (isSessionChangedEvent(msg)) {
        const realId = msg.event.sessionId;
        rekeyChannel(pendingId, realId);
        sessions.delete(pendingId);
        sessions.set(realId, channel);
        unsubscribe(channel, rekeySubscriber);
      }
    },
  };
  subscribe(channel, rekeySubscriber);

  return { pendingId, channel };
}

/**
 * Create a forked session from an existing session.
 *
 * Same `pending:<uuid>` + rekey pattern as createSession(), but opens
 * with mode 'fork' so the adapter resumes the source session and
 * truncates at the specified message ID.
 *
 * Returns the pendingId and channel so the caller can track the transition.
 */
export function createForkSession(
  vendor: Vendor,
  fromSessionId: string,
  subscriber: Subscriber,
  options?: {
    atMessageId?: string;
    settings?: TurnSettings;
  },
  explicitPendingId?: string,
): { pendingId: string; channel: SessionChannel } {
  const registration = adapters.get(vendor);
  if (!registration) throw new Error(`No adapter registered for vendor "${vendor}".`);

  const pendingId = explicitPendingId ?? `pending:${crypto.randomUUID()}`;
  const spec: SessionOpenSpec = {
    mode: 'fork',
    fromSessionId,
    ...(options?.atMessageId && { atMessageId: options.atMessageId }),
  };

  const channel = openChannel(pendingId, vendor, spec);
  sessions.set(pendingId, channel);
  subscribe(channel, subscriber);

  // One-shot session-list notifier: pushes upsert when the real session ID resolves
  const listNotifySubscriber: Subscriber = {
    id: `__list_notify__${pendingId}`,
    send(msg) {
      if (isSessionChangedEvent(msg)) {
        refreshAndNotify(msg.event.sessionId);
        unsubscribe(channel, listNotifySubscriber);
      }
    },
  };
  subscribe(channel, listNotifySubscriber);

  // One-shot re-key subscriber: swaps pending → real ID on session_changed
  const rekeySubscriber: Subscriber = {
    id: `__rekey__${pendingId}`,
    send(msg) {
      if (isSessionChangedEvent(msg)) {
        const realId = msg.event.sessionId;
        rekeyChannel(pendingId, realId);
        sessions.delete(pendingId);
        sessions.set(realId, channel);
        unsubscribe(channel, rekeySubscriber);
      }
    },
  };
  subscribe(channel, rekeySubscriber);

  return { pendingId, channel };
}

// ============================================================================
// Unified Send Surface
// ============================================================================

/**
 * Build a TranscriptEntry from a TurnIntent for optimistic user rendering.
 */
function buildUserEntry(intent: TurnIntent): TranscriptEntry {
  // Convert MessageContent to message content blocks
  const contentBlocks = typeof intent.content === 'string'
    ? [{ type: 'text' as const, text: intent.content }]
    : intent.content;

  return {
    type: 'user',
    uuid: intent.clientMessageId,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: contentBlocks,
    },
  };
}

/**
 * Send a user turn with unified routing.
 *
 * This is the primary entry point for sending user messages. It:
 * 1. Routes by target kind (existing/new/fork)
 * 2. Broadcasts the user entry to all subscribers before the adapter sees it
 * 3. Calls adapter.sendTurn() with full settings
 *
 * Returns a TurnReceipt with the session ID (may be pending:<uuid> for new/fork).
 */
export function sendTurn(intent: TurnIntent, subscriber: Subscriber, pendingId?: string): TurnReceipt {
  let channel: SessionChannel;
  let sessionId: string;

  switch (intent.target.kind) {
    case 'existing':
      channel = requireChannel(intent.target.sessionId);
      sessionId = intent.target.sessionId;
      break;

    case 'new': {
      const created = createSession(
        intent.target.vendor as Vendor,
        intent.target.cwd,
        subscriber,
        intent.settings,
        pendingId,
      );
      channel = created.channel;
      sessionId = created.pendingId;
      break;
    }

    case 'fork': {
      const forked = createForkSession(
        intent.target.vendor as Vendor,
        intent.target.fromSessionId,
        subscriber,
        { atMessageId: intent.target.atMessageId, settings: intent.settings },
        pendingId,
      );
      channel = forked.channel;
      sessionId = forked.pendingId;
      break;
    }
  }

  // Broadcast user entry to all subscribers before adapter sees it
  const userEntry = buildUserEntry(intent);
  channelBroadcastUserEntry(channel, userEntry);

  // Send to adapter with full settings
  channel.adapter!.sendTurn(intent.content, intent.settings);

  // Broadcast settings_changed so all subscribers (including other panels)
  // see the updated settings after adapter.sendTurn() applies them.
  const settingsMsg: ChannelMessage = {
    type: 'event',
    event: {
      type: 'notification',
      kind: 'settings_changed',
      settings: channel.adapter!.settings,
    },
  };
  for (const [, sub] of channel.subscribers) {
    try { sub.send(settingsMsg); } catch { /* swallow */ }
  }

  return { sessionId };
}

// ============================================================================
// Deprecated Session Operations
// ============================================================================

/**
 * Send a message into a session's live channel.
 *
 * Options (model, permissionMode, etc.) are threaded through to the
 * adapter so they can be applied atomically at query start time.
 * Throws if no channel is open for this sessionId.
 *
 * @deprecated Use sendTurn() instead. This function is retained for
 * backwards compatibility during the migration.
 */
export function sendToSession(sessionId: string, content: MessageContent, options?: SendOptions): void {
  const channel = requireChannel(sessionId);
  sendMessage(channel, content, options);
}

/**
 * Change the model for a session's adapter.
 * Throws if no channel is open for this sessionId.
 *
 * @deprecated Use sendTurn() with settings.model instead. This function is
 * retained for backwards compatibility during the migration.
 */
export async function setSessionModel(
  sessionId: string,
  model?: string,
): Promise<void> {
  const channel = requireChannel(sessionId);
  if (!channel.adapter) {
    throw new Error(`Channel for session "${sessionId}" has no adapter.`);
  }
  await channel.adapter.setModel(model);
}

/**
 * Interrupt the active query on a session (pause, not kill).
 * Throws if no channel is open for this sessionId.
 */
export async function interruptSession(sessionId: string): Promise<void> {
  const channel = requireChannel(sessionId);
  if (!channel.adapter) {
    throw new Error(`Channel for session "${sessionId}" has no adapter.`);
  }
  await channel.adapter.interrupt();
}

/**
 * Close a session's live channel and remove it from the registry.
 *
 * Delegates to destroyChannel() which tears down the adapter and
 * notifies subscribers, then removes the entry from the sessions map.
 * No-op if no channel is open for this sessionId.
 */
export function closeSession(sessionId: string): void {
  if (!sessions.has(sessionId)) return;
  destroyChannel(sessionId);
  sessions.delete(sessionId);
}
