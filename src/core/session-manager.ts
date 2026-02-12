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

import type { AgentAdapter, VendorDiscovery, SessionInfo, SendOptions } from './agent-adapter.js';
import type { TranscriptEntry, Vendor, MessageContent } from './transcript.js';
import type { SessionChannel, Subscriber } from './session-channel.js';
import {
  createChannel, setAdapter, subscribe,
  sendMessage, destroyChannel, backfillHistory,
} from './session-channel.js';

// ============================================================================
// Types
// ============================================================================

/** Registration entry: static discovery + factory for per-session adapters. */
export interface VendorRegistration {
  discovery: VendorDiscovery;
  createAdapter: (sessionId: string) => AgentAdapter;
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
  createAdapter: (sessionId: string) => AgentAdapter,
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
export async function loadSession(sessionId: string): Promise<TranscriptEntry[]> {
  const info = findSession(sessionId);
  if (!info) return [];

  const reg = adapters.get(info.vendor);
  if (!reg) return [];

  return reg.discovery.loadHistory(sessionId);
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
function openChannel(sessionId: string, vendor: Vendor): SessionChannel {
  const registration = adapters.get(vendor);
  if (!registration) {
    throw new Error(`No adapter registered for vendor "${vendor}".`);
  }

  const liveAdapter = registration.createAdapter(sessionId);
  const channel = createChannel(sessionId);
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

      const ch = openChannel(sessionId, info.vendor);
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
 * Send a message into a session's live channel.
 *
 * Options (model, permissionMode, etc.) are threaded through to the
 * adapter so they can be applied atomically at query start time.
 * Throws if no channel is open for this sessionId.
 */
export function sendToSession(sessionId: string, content: MessageContent, options?: SendOptions): void {
  const channel = requireChannel(sessionId);
  sendMessage(channel, content, options);
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
