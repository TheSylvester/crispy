/**
 * Session Manager — Cross-Vendor Orchestration Layer
 *
 * The entry point for vendor-agnostic session operations. Maintains a
 * registry of vendor adapters and provides session-ID-keyed operations
 * across all of them.
 *
 * Two registries:
 * - adapters: Map<Vendor, AgentAdapter> — one adapter per vendor
 * - sessions: Map<string, SessionChannel> — live channels keyed by sessionId
 *
 * Design matches session-channel.ts: functional API with module-level state.
 *
 * Ownership model: one adapter instance per vendor, one live channel per
 * session. Because adapters are single-consumer (messages() can only be
 * iterated once), only one live session per vendor is allowed at a time.
 * Opening a second session for the same vendor requires closing the first.
 *
 * @module session-manager
 */

import type { AgentAdapter, SessionInfo } from './agent-adapter.js';
import type { TranscriptEntry, Vendor, MessageContent } from './transcript.js';
import type { SessionChannel, Subscriber } from './session-channel.js';
import {
  createChannel, setAdapter, subscribe,
  sendMessage, destroyChannel, loadHistory,
} from './session-channel.js';

// ============================================================================
// Registries
// ============================================================================

/** One adapter per vendor. */
const adapters = new Map<Vendor, AgentAdapter>();

/** Live channels keyed by sessionId. */
const sessions = new Map<string, SessionChannel>();

/** In-flight channel initialization promises — guards concurrent subscribeSession(). */
const pending = new Map<string, Promise<SessionChannel>>();

// ============================================================================
// Adapter Registry
// ============================================================================

/**
 * Register an adapter for its vendor.
 * Throws if an adapter for that vendor is already registered.
 */
export function registerAdapter(adapter: AgentAdapter): void {
  if (adapters.has(adapter.vendor)) {
    throw new Error(
      `Adapter for vendor "${adapter.vendor}" is already registered. ` +
      `Call unregisterAdapter("${adapter.vendor}") first.`
    );
  }
  adapters.set(adapter.vendor, adapter);
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

/** Get the adapter for a specific vendor. */
export function getAdapter(vendor: Vendor): AgentAdapter | undefined {
  return adapters.get(vendor);
}

/** Get all registered adapters. */
export function getAdapters(): AgentAdapter[] {
  return [...adapters.values()];
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
  for (const adapter of adapters.values()) {
    const info = adapter.findSession(sessionId);
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
export async function loadSession(sessionId: string): Promise<TranscriptEntry[]> {
  const info = findSession(sessionId);
  if (!info) return [];

  const adapter = adapters.get(info.vendor);
  if (!adapter) return [];

  return adapter.loadHistory(sessionId);
}

/**
 * Aggregate all sessions from all registered adapters.
 * Sorted by modifiedAt descending (most recent first).
 */
export function listAllSessions(): SessionInfo[] {
  const all: SessionInfo[] = [];
  for (const adapter of adapters.values()) {
    all.push(...adapter.listSessions());
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
 * Find any live session using the given vendor's adapter.
 * Returns the sessionId or undefined.
 */
function findLiveSessionForVendor(vendor: Vendor): string | undefined {
  for (const [sessionId, channel] of sessions) {
    if (channel.adapter?.vendor === vendor && channel.state !== 'unattached') {
      return sessionId;
    }
  }
  return undefined;
}

/**
 * Create a channel for a session, wiring up the owning vendor's adapter.
 * Internal — not exported. Uses sessionId as channelId (1:1 mapping).
 *
 * Because adapters are single-consumer (messages() can only be iterated
 * once), this throws if another live session for the same vendor exists.
 * Close the existing session first via closeSession().
 */
function openChannel(sessionId: string, vendor: Vendor): SessionChannel {
  const adapter = adapters.get(vendor);
  if (!adapter) {
    throw new Error(`No adapter registered for vendor "${vendor}".`);
  }

  // Enforce one live session per vendor (adapter is single-consumer)
  const existing = findLiveSessionForVendor(vendor);
  if (existing) {
    throw new Error(
      `Vendor "${vendor}" already has a live session "${existing}". ` +
      `Call closeSession("${existing}") before opening a new one.`
    );
  }

  const channel = createChannel(sessionId);
  setAdapter(channel, adapter);
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
 * Throws if the session is not found across any registered vendor, or if
 * the vendor already has another live session (adapters are single-consumer).
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

      const ch = openChannel(sessionId, info.vendor);
      sessions.set(sessionId, ch);

      // Backfill transcript history for subscribers.
      // If this fails, clean up the partially-initialized channel
      // so the next caller gets a clean slate, not a poisoned entry.
      try {
        await loadHistory(ch, sessionId);
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
 * Send a message into a session's live channel.
 * Throws if no channel is open for this sessionId.
 */
export function sendToSession(sessionId: string, content: MessageContent): void {
  const channel = requireChannel(sessionId);
  sendMessage(channel, content);
}

/**
 * Change the model for a session's adapter.
 * Throws if no channel is open for this sessionId.
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
 * Change the permission mode for a session's adapter.
 * Throws if no channel is open for this sessionId.
 */
export async function setSessionPermissions(
  sessionId: string,
  mode: string,
): Promise<void> {
  const channel = requireChannel(sessionId);
  if (!channel.adapter) {
    throw new Error(`Channel for session "${sessionId}" has no adapter.`);
  }
  await channel.adapter.setPermissionMode(mode);
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
