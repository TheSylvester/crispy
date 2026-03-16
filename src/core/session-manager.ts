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
 * Session ID input contract: external session IDs (CLI args, UI input, env
 * vars) must pass through resolveSessionPrefix() before use. This silently
 * expands truncated prefixes to full UUIDs when unambiguous.
 *
 * Ownership model: each vendor registers a VendorDiscovery object for
 * stateless ops (listSessions, findSession, loadHistory) and a factory
 * that creates a fresh AgentAdapter per live session. Each channel owns
 * its adapter exclusively, so multiple live sessions per vendor are supported.
 *
 * @module session-manager
 */

import type { AgentAdapter, VendorDiscovery, SessionInfo, SessionOpenSpec, ChannelMessage, TurnIntent, TurnTarget, TurnSettings, SubagentEntriesResult, EphemeralTargetOptions } from './agent-adapter.js';
import type { TranscriptEntry, MessageContent, Vendor } from './transcript.js';
import type { SessionChannel, Subscriber, SubscriberMessage } from './session-channel.js';
import { parseModelOption } from './model-utils.js';

import {
  createChannel, setAdapter, subscribe, unsubscribe,
  destroyChannel, rekeyChannel, getChannel,
  broadcastUserEntry as channelBroadcastUserEntry,
} from './session-channel.js';
import { refreshAndNotify, notifyStatusChange } from './session-list-manager.js';
import { fireResponseComplete } from './lifecycle-hooks.js';
import { pushRosieLog } from './rosie/index.js';

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

/** Maps pending IDs to their resolved real IDs for CLI session resolution. */
const pendingToReal = new Map<string, string>();

// ============================================================================
// Child Session Dispatch
// ============================================================================

/** Idle debounce window (ms). After an idle event, wait this long before
 *  resolving. If 'active' fires within the window, the timer resets.
 *  Prevents spurious early resolution in multi-step agent work. */
const IDLE_SETTLE_MS = 2000;

export interface ChildSessionOptions {
  /** Session that's spawning this child. */
  parentSessionId: string;
  /** Vendor for the child session. */
  vendor: string;
  /** Vendor of the parent session — fork if same, new session if different. */
  parentVendor: string;
  /** Message content to send as the child's first turn. */
  prompt: MessageContent;
  /** Turn settings (model, outputFormat, permissionMode, etc.). */
  settings?: TurnSettings;
  /** Don't persist the child session to disk (default: true). */
  skipPersistSession?: boolean;
  /** Auto-close the child channel when it goes idle (default: true). */
  autoClose?: boolean;
  /** Timeout in ms before giving up and returning null (default: 60000). */
  timeoutMs?: number;
  /** Force `kind: 'new'` even when vendor matches parent (skip fork transcript loading). */
  forceNew?: boolean;
  /** Pre-loaded, pre-filtered history to use for a hydrated fork (bypasses loadHistory). */
  hydratedHistory?: TranscriptEntry[];
  /** MCP servers to attach to the child session (overrides default). */
  mcpServers?: Record<string, unknown>;
  /** Environment overrides for the child session. */
  env?: Record<string, string>;
  /** Explicit working directory — overrides parent session's projectPath. */
  cwd?: string;
}

export interface ChildSessionResult {
  sessionId: string;
  text: string;
  structured?: unknown;
}

/** Parent->child relationship tracking. Used by dispatchChildSession for lifecycle management.
 *  `visible` sessions get session-list notifications (appear in editor UI) but still
 *  skip lifecycle hooks (Rosie won't process them). */
const childSessions = new Map<string, {
  parentSessionId: string;
  autoClose: boolean;
  visible: boolean;
}>();

/** Check if a session was spawned by dispatchChildSession or registered as a child
 *  via registerChildSession. Used by lifecycle-hooks to prevent recursive hook chains
 *  (e.g. Rosie analyzing its own child sessions). */
export function isChildSession(sessionId: string): boolean {
  return childSessions.has(sessionId);
}

/**
 * Register a session as a child for provenance tracking.
 * Used by IPC dispatch (--visible mode) to mark sendTurn-created sessions
 * so Rosie skips them while still allowing session-list notifications.
 */
export function registerChildSession(
  sessionId: string,
  meta: { parentSessionId: string; autoClose: boolean; visible: boolean },
): void {
  childSessions.set(sessionId, meta);
}

/**
 * Re-key a child session registration (pending → real ID).
 * No-op if the old ID isn't tracked.
 */
export function rekeyChildSession(oldId: string, newId: string): void {
  const entry = childSessions.get(oldId);
  if (entry) {
    childSessions.delete(oldId);
    childSessions.set(newId, entry);
  }
}

/**
 * Resolve a pending session ID to its real ID, or return as-is if not pending.
 * Used by the CLI rpc pipe so LLMs holding a $CRISPY_SESSION_ID can resolve it.
 */
export function resolveSessionId(sessionId: string): string {
  if (!sessionId.startsWith('pending:')) return sessionId;
  return pendingToReal.get(sessionId) ?? sessionId;
}

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
  invalidateSessionCache();
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
  invalidateSessionCache();
}

/** Get the discovery object for a specific vendor. */
export function getDiscovery(vendor: Vendor): VendorDiscovery | undefined {
  return adapters.get(vendor)?.discovery;
}

/** Get all registered discovery objects. */
export function getDiscoveries(): VendorDiscovery[] {
  return [...adapters.values()].map((r) => r.discovery);
}

/** Get the set of vendor slugs that have a registered adapter. */
export function getRegisteredVendors(): Set<string> {
  return new Set(adapters.keys());
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
  invalidateSessionCache();
}

// ============================================================================
// Cross-Vendor Discovery
// ============================================================================

/** Standard UUID length (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). */
const UUID_FULL_LENGTH = 36;

/**
 * Resolve a possibly-truncated session ID to its full UUID.
 * - Full-length IDs pass through unchanged (no scan).
 * - Shorter strings scan listAllSessions() for unique startsWith match.
 * - Throws on ambiguous prefix (multiple matches).
 * - Returns the input unchanged if no prefix match found (let callers
 *   handle "not found" in their own way).
 *
 * Call this at any input boundary that accepts a session ID from external
 * sources (user input, CLI args, env vars) before passing it downstream.
 */
export function resolveSessionPrefix(sessionId: string): string {
  if (sessionId.length >= UUID_FULL_LENGTH) return sessionId;
  if (sessionId.length === 0) return sessionId;

  const matches = listAllSessions().filter(
    (s) => s.sessionId.startsWith(sessionId),
  );
  if (matches.length === 1) return matches[0].sessionId;
  if (matches.length > 1) {
    const ids = matches.slice(0, 5).map((s) => s.sessionId);
    const suffix = matches.length > 5 ? ` (and ${matches.length - 5} more)` : '';
    throw new Error(
      `Ambiguous session prefix "${sessionId}" matches ${matches.length} sessions: ${ids.join(', ')}${suffix}`,
    );
  }
  return sessionId;
}

/**
 * Find a session by ID across all registered adapters.
 * Supports prefix matching: short IDs are silently resolved via
 * resolveSessionPrefix() before lookup.
 */
export function findSession(sessionId: string): SessionInfo | undefined {
  const resolved = resolveSessionPrefix(sessionId);
  for (const { discovery } of adapters.values()) {
    const info = discovery.findSession(resolved);
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
 * Read sub-agent transcript entries incrementally.
 *
 * Routes through the vendor's discovery.readSubagentEntries() if available.
 * Returns { entries: [], cursor, done: true } for unknown sessions or vendors
 * that don't support sub-agent reading.
 */
export function readSubagentEntries(
  sessionId: string,
  agentId: string,
  parentToolUseId: string,
  cursor: string,
): SubagentEntriesResult {
  const info = findSession(sessionId);
  if (!info) return { entries: [], cursor, done: true };

  const reg = adapters.get(info.vendor);
  if (!reg?.discovery.readSubagentEntries) {
    return { entries: [], cursor, done: true };
  }

  return reg.discovery.readSubagentEntries(sessionId, agentId, parentToolUseId, cursor);
}

/**
 * Aggregate all sessions from all registered adapters.
 * Sorted by modifiedAt descending (most recent first).
 */
/** Short-lived cache for listAllSessions() — avoids duplicate I/O during startup. */
let cachedSessions: SessionInfo[] | null = null;
let cacheTime = 0;
const SESSION_CACHE_TTL_MS = 5_000;

/** Invalidate the listAllSessions() cache (called when adapters change). */
function invalidateSessionCache(): void {
  cachedSessions = null;
  cacheTime = 0;
}

export function listAllSessions(): SessionInfo[] {
  const now = Date.now();
  if (cachedSessions && now - cacheTime < SESSION_CACHE_TTL_MS) {
    return cachedSessions;
  }
  const all: SessionInfo[] = [];
  for (const { discovery } of adapters.values()) {
    all.push(...discovery.listSessions());
  }
  const result = all
    .filter(s => !s.isSidechain)
    .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  cachedSessions = result;
  cacheTime = now;
  return result;
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
    // Child sessions (internal dispatches) don't fire lifecycle hooks.
    // Check here — before broadcast delivers the idle event to subscribers
    // whose cleanup() would delete the childSessions entry. The existing
    // guard in fireResponseComplete is defense-in-depth but races with cleanup.
    const childMeta = childSessions.get(sessionId);
    if (childMeta && !childMeta.visible) return; // hidden child: skip everything
    if (childMeta?.visible) {
      // Visible child: notify session list (appears in editor UI) but
      // still skip lifecycle hooks (Rosie won't process it).
      // Re-resolve sessionId inside setTimeout to handle pending→real rekey
      // that may have happened since idle fired (fix #3: stale-ID race).
      setTimeout(() => {
        const currentId = channel.adapter?.sessionId ?? sessionId;
        refreshAndNotify(currentId);
        if (childMeta.autoClose) {
          closeSession(currentId);
          childSessions.delete(currentId);
          if (currentId !== sessionId) childSessions.delete(sessionId);
        }
      }, 150);
      return;
    }
    // Small grace period: the adapter emits idle synchronously when the SDK
    // yields the result message, but the SDK may not have flushed the JSONL
    // file to disk yet. 150ms is enough for the OS write buffer to flush.
    // The 30s rescan is a fallback either way.
    setTimeout(() => {
      refreshAndNotify(sessionId);
      // Fire lifecycle hooks (Rosie, future features). Fire-and-forget —
      // handlers are error-isolated and run concurrently.
      fireResponseComplete(sessionId);
    }, 150);
  };

  channel.onStatusChange = (state) => {
    const sessionId = channel.adapter?.sessionId;
    if (!sessionId) return;
    const childMeta = childSessions.get(sessionId);
    // Hidden children skip status notifications entirely.
    // Visible children broadcast status so the editor UI can show live state.
    if (childMeta && !childMeta.visible) return;
    notifyStatusChange(sessionId, state);
  };

  setAdapter(channel, liveAdapter);
  return channel;
}

// ============================================================================
// Pending Channel Factory
// ============================================================================

/** Result from creating a pending channel. */
export interface PendingChannelResult {
  pendingId: string;
  channel: SessionChannel;
  rekeyPromise: Promise<string>;
}

/**
 * Create a pending channel with automatic re-keying on session_changed.
 *
 * This is the shared boilerplate for createSession(), createForkSession(),
 * and vendor-switch in sendTurn(). It:
 * 1. Generates a pending:<uuid> ID (or uses explicitPendingId)
 * 2. Opens the channel with the spec
 * 3. Registers in the sessions map
 * 4. Subscribes the caller's subscriber
 * 5. Sets up one-shot subscribers for list notify and re-keying
 * 6. Optionally includes history entries in catchup (for vendor-switch)
 *
 * Returns the pendingId, channel, and a promise that resolves to the
 * real session ID when session_changed fires.
 */
function createPendingChannel(
  vendor: Vendor,
  spec: SessionOpenSpec,
  subscriber: Subscriber,
  options?: {
    explicitPendingId?: string;
    entries?: TranscriptEntry[];
  },
): PendingChannelResult {
  const pendingId = options?.explicitPendingId ?? `pending:${crypto.randomUUID()}`;

  // Inject CRISPY_SESSION_ID so LLMs in managed sessions can self-identify.
  // For resume, the real session ID is already known; for fresh/fork, use the
  // pending ID (resolved later via resolveSessionId()).
  const envSessionId = spec.mode === 'resume' ? spec.sessionId! : pendingId;
  spec = { ...spec, env: { ...spec.env, CRISPY_SESSION_ID: envSessionId } };

  const channel = openChannel(pendingId, vendor, spec);
  sessions.set(pendingId, channel);

  // Subscribe with entries (history is included in catchup message)
  subscribe(channel, subscriber, options?.entries);

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
  // Also resolves the rekeyPromise with the real session ID.
  // Wrapped with a 15s timeout safety net to prevent indefinite hangs.
  const rekeyPromise = new Promise<string>((resolve, reject) => {
    let settled = false;
    const rekeySubscriber: Subscriber = {
      id: `__rekey__${pendingId}`,
      send(msg) {
        if (isSessionChangedEvent(msg)) {
          settled = true;
          const realId = msg.event.sessionId;
          rekeyChannel(pendingId, realId);
          pushRosieLog({ source: 'session', level: 'info', summary: `Session: re-keyed ${pendingId.slice(0, 20)}… → ${realId.slice(0, 12)}…`, data: { pendingId, realId } });
          sessions.delete(pendingId);
          sessions.set(realId, channel);
          pendingToReal.set(pendingId, realId);
          unsubscribe(channel, rekeySubscriber);
          resolve(realId);
        }
      },
    };
    subscribe(channel, rekeySubscriber);

    // Timeout safety net: reject if re-key never fires
    setTimeout(() => {
      if (settled) return;
      unsubscribe(channel, rekeySubscriber);
      pushRosieLog({ source: 'session', level: 'error', summary: `Re-key timeout: ${pendingId.slice(0, 20)}… (15s)`, data: { pendingId } });
      destroyChannel(pendingId);
      sessions.delete(pendingId);
      reject(new Error(`Fork timed out: session re-key did not complete within 15 seconds (${pendingId})`));
    }, 15_000);
  });

  return { pendingId, channel, rekeyPromise };
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
 *   loadHistory() loads transcript entries which are included in the catchup.
 * - Adds the subscriber to the channel with history entries in the catchup message.
 * - Returns the channel.
 *
 * @param until Optional truncation point (message UUID) for fork/rewind support.
 *              When provided, history is truncated at this entry (inclusive).
 *
 * Throws if the session is not found across any registered vendor.
 */
export async function subscribeSession(
  sessionId: string,
  subscriber: Subscriber,
  until?: string,
): Promise<SessionChannel> {
  // Evict dead channels so we don't reuse terminal state
  evictIfDead(sessionId);

  // If another call is already initializing this session, wait for it
  const inflight = pending.get(sessionId);
  if (inflight) {
    const channel = await inflight;
    // Load history for this subscriber (may differ from init if using `until`)
    const entries = await loadSession(sessionId, { until });
    subscribe(channel, subscriber, entries);
    return channel;
  }

  let channel = sessions.get(sessionId);
  let entries: TranscriptEntry[] = [];

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

      // Load transcript history for subscribers.
      // If this fails, clean up the partially-initialized channel
      // so the next caller gets a clean slate, not a poisoned entry.
      try {
        const reg = adapters.get(info.vendor)!;
        entries = await reg.discovery.loadHistory(sessionId);
        // Apply truncation if specified
        if (until) {
          const cutIdx = entries.findIndex(e => e.uuid === until);
          if (cutIdx !== -1) {
            entries = entries.slice(0, cutIdx + 1);
          } else {
            pushRosieLog({ source: 'session', level: 'warn', summary: 'Fork truncation UUID not found, loading full history', data: { sessionId, until } });
          }
        }
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
  } else {
    // Channel exists — load entries for this subscriber
    entries = await loadSession(sessionId, { until });
  }

  subscribe(channel, subscriber, entries);
  return channel;
}

/**
 * Create a brand-new session (no resume ID).
 *
 * Delegates to createPendingChannel() which handles pending:<uuid> generation,
 * channel registration, and one-shot subscribers for list notify and re-keying.
 *
 * Returns the pendingId and channel so the caller can track the transition.
 */
export function createSession(
  vendor: Vendor,
  cwd: string,
  subscriber: Subscriber,
  options?: { model?: string; permissionMode?: TurnSettings['permissionMode']; extraArgs?: Record<string, string | null>; skipPersistSession?: boolean; mcpServers?: Record<string, unknown>; env?: Record<string, string>; systemPrompt?: string },
  explicitPendingId?: string,
): PendingChannelResult {
  if (!adapters.has(vendor)) {
    throw new Error(`No adapter registered for vendor "${vendor}".`);
  }

  const spec: SessionOpenSpec = {
    mode: 'fresh',
    cwd,
    ...(options?.model && { model: options.model }),
    ...(options?.permissionMode && { permissionMode: options.permissionMode }),
    ...(options?.extraArgs && { extraArgs: options.extraArgs }),
    ...(options?.skipPersistSession && { skipPersistSession: true }),
    ...(options?.mcpServers && { mcpServers: options.mcpServers }),
    ...(options?.env && { env: options.env }),
    ...(options?.systemPrompt && { systemPrompt: options.systemPrompt }),
  };

  return createPendingChannel(vendor, spec, subscriber, { explicitPendingId });
}

/**
 * Create a forked session from an existing session.
 *
 * If the vendor supports SDK-level pre-forking (preFork), the fork JSONL is
 * materialized on disk first, yielding a real session ID immediately. The
 * channel is opened with mode 'resume' using that real ID — no pending→real
 * re-key dance needed.
 *
 * Otherwise falls through to createPendingChannel() with mode 'fork' and the
 * standard re-key flow (plus timeout safety net).
 *
 * Returns the pendingId (or realId) and channel so the caller can track the transition.
 */
export async function createForkSession(
  vendor: Vendor,
  fromSessionId: string,
  subscriber: Subscriber,
  options?: {
    atMessageId?: string;
    settings?: TurnSettings;
    skipPersistSession?: boolean;
    mcpServers?: Record<string, unknown>;
    env?: Record<string, string>;
    systemPrompt?: string;
  },
  explicitPendingId?: string,
): Promise<PendingChannelResult> {
  const reg = adapters.get(vendor);
  if (!reg) {
    throw new Error(`No adapter registered for vendor "${vendor}".`);
  }

  // Validate that the source session actually exists before creating any channels
  if (!reg.discovery.findSession(fromSessionId)) {
    throw new Error(`Cannot fork: source session "${fromSessionId}" not found.`);
  }

  // Pre-fork path: materialize fork on disk, get real ID, open as resume
  if (reg.discovery.preFork) {
    try {
      const sourceInfo = findSession(fromSessionId);
      const dir = sourceInfo?.projectPath;
      const { sessionId: realId } = await reg.discovery.preFork(fromSessionId, {
        atMessageId: options?.atMessageId,
        dir,
      });

      pushRosieLog({ source: 'session', level: 'info', summary: `Pre-fork materialized: ${realId.slice(0, 12)}…`, data: { fromSessionId, realId } });

      // Open channel with real ID directly — no pending prefix, no re-key
      const spec: SessionOpenSpec = {
        mode: 'resume',
        sessionId: realId,
      };
      const channel = openChannel(realId, vendor, spec);
      sessions.set(realId, channel);
      subscribe(channel, subscriber);

      // Notify session list of the new session
      refreshAndNotify(realId);

      // Return a resolved rekeyPromise since the ID is already real
      return { pendingId: realId, channel, rekeyPromise: Promise.resolve(realId) };
    } catch (err) {
      pushRosieLog({ source: 'session', level: 'warn', summary: `Pre-fork failed, falling back to pending channel`, data: { fromSessionId, error: String(err) } });
      // Fall through to legacy fork path
    }
  }

  // Legacy fork path: pending channel with re-key
  const spec: SessionOpenSpec = {
    mode: 'fork',
    fromSessionId,
    ...(options?.atMessageId && { atMessageId: options.atMessageId }),
    ...(options?.settings?.model && { model: options.settings.model }),
    ...(options?.settings?.outputFormat && { outputFormat: options.settings.outputFormat }),
    ...(options?.skipPersistSession && { skipPersistSession: true }),
    ...(options?.mcpServers && { mcpServers: options.mcpServers }),
    ...(options?.env && { env: options.env }),
    ...(options?.systemPrompt && { systemPrompt: options.systemPrompt }),
  };

  return createPendingChannel(vendor, spec, subscriber, { explicitPendingId });
}

// ============================================================================
// Unified Send Surface
// ============================================================================

/**
 * Internal result from sendTurn() — includes the channel for client-connection.
 *
 * This is NOT part of the wire contract (TurnReceipt stays as { sessionId }).
 * It allows client-connection to get the channel directly from sendTurn()
 * instead of calling getChannel() — eliminating the leaked abstraction.
 */
export interface InternalTurnResult {
  sessionId: string;
  channel: SessionChannel;
  /** Promise that resolves to the real session ID on session_changed. Undefined for existing sessions. */
  rekeyPromise?: Promise<string>;
}

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
 * 1. Routes by target kind (existing/new/fork/continueIn)
 * 2. Broadcasts the user entry to all subscribers before the adapter sees it
 * 3. Calls adapter.sendTurn() with full settings
 *
 * Returns InternalTurnResult with sessionId, channel, and rekeyPromise.
 * The channel is returned directly so client-connection doesn't need getChannel().
 */
export async function sendTurn(intent: TurnIntent, subscriber: Subscriber, pendingId?: string): Promise<InternalTurnResult> {
  let channel: SessionChannel;
  let sessionId: string;
  let rekeyPromise: Promise<string> | undefined;

  try {
  switch (intent.target.kind) {
    case 'existing': {
      channel = requireChannel(intent.target.sessionId);
      sessionId = intent.target.sessionId;
      const currentVendor = channel.adapter?.vendor;

      // Check for vendor switch via the model field
      if (intent.target.model && currentVendor) {
        const { vendor: targetVendor, model } = parseModelOption(intent.target.model);
        if (targetVendor !== currentVendor) {
          // Vendor switch — load source history and create hydrated session
          const sourceInfo = findSession(sessionId);
          const sourceReg = adapters.get(currentVendor);
          if (!sourceReg) throw new Error(`No adapter registered for source vendor "${currentVendor}".`);
          if (!adapters.has(targetVendor)) throw new Error(`No adapter registered for target vendor "${targetVendor}".`);

          const history = await sourceReg.discovery.loadHistory(sessionId);

          const spec: SessionOpenSpec = {
            mode: 'hydrated',
            cwd: sourceInfo?.projectPath ?? process.cwd(),
            history,
            sourceVendor: currentVendor,
            sourceSessionId: sessionId,
            ...(model && { model }),
            ...(intent.settings.permissionMode && { permissionMode: intent.settings.permissionMode }),
          };

          const result = createPendingChannel(targetVendor, spec, subscriber, {
            explicitPendingId: pendingId,
            entries: history,
          });

          // Unsubscribe from old channel — do NOT closeSession(), which
          // would globally destroy the channel for all other subscribers.
          unsubscribe(channel, subscriber);

          channel = result.channel;
          sessionId = result.pendingId;
          rekeyPromise = result.rekeyPromise;
        }
      }
      break;
    }

    case 'new': {
      const created = createSession(
        intent.target.vendor as Vendor,
        intent.target.cwd,
        subscriber,
        {
          ...intent.settings,
          ...(intent.target.skipPersistSession && { skipPersistSession: true }),
          ...(intent.target.mcpServers && { mcpServers: intent.target.mcpServers }),
          ...(intent.target.env && { env: intent.target.env }),
          ...(intent.target.systemPrompt && { systemPrompt: intent.target.systemPrompt }),
        },
        pendingId,
      );
      channel = created.channel;
      sessionId = created.pendingId;
      rekeyPromise = created.rekeyPromise;
      break;
    }

    case 'fork': {
      const forked = await createForkSession(
        intent.target.vendor as Vendor,
        intent.target.fromSessionId,
        subscriber,
        {
          atMessageId: intent.target.atMessageId,
          settings: intent.settings,
          ...(intent.target.skipPersistSession && { skipPersistSession: true }),
          ...(intent.target.mcpServers && { mcpServers: intent.target.mcpServers }),
          ...(intent.target.env && { env: intent.target.env }),
          ...(intent.target.systemPrompt && { systemPrompt: intent.target.systemPrompt }),
        },
        pendingId,
      );
      channel = forked.channel;
      sessionId = forked.pendingId;
      rekeyPromise = forked.rekeyPromise;
      break;
    }

    case 'hydrated': {
      const spec: SessionOpenSpec = {
        mode: 'hydrated',
        cwd: intent.target.cwd,
        history: intent.target.history,
        sourceVendor: intent.target.sourceVendor,
        ...(intent.target.sourceSessionId && { sourceSessionId: intent.target.sourceSessionId }),
        ...(intent.settings.model && { model: intent.settings.model }),
        ...(intent.settings.permissionMode && { permissionMode: intent.settings.permissionMode }),
        ...(intent.target.skipPersistSession && { skipPersistSession: true }),
        ...(intent.target.systemPrompt && { systemPrompt: intent.target.systemPrompt }),
      };

      const result = createPendingChannel(intent.target.vendor, spec, subscriber, {
        explicitPendingId: pendingId,
        entries: intent.target.history,
      });
      channel = result.channel;
      sessionId = result.pendingId;
      rekeyPromise = result.rekeyPromise;
      break;
    }
  }

  pushRosieLog({
    source: 'session',
    level: 'info',
    summary: `Turn: ${intent.target.kind} (${intent.target.kind === 'existing' ? intent.target.sessionId.slice(0, 12) : intent.target.kind === 'fork' ? intent.target.fromSessionId.slice(0, 12) : 'new'}…)`,
    data: {
      kind: intent.target.kind,
      vendor: 'vendor' in intent.target ? intent.target.vendor : undefined,
      sessionId,
      ...(intent.target.kind === 'fork' && {
        fromSessionId: intent.target.fromSessionId,
        atMessageId: intent.target.atMessageId,
      }),
      model: intent.settings?.model,
      pendingId: sessionId.startsWith('pending:') ? sessionId : undefined,
    },
  });

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

  return { sessionId, channel, rekeyPromise };

  } catch (err) {
    pushRosieLog({
      source: 'session',
      level: 'error',
      summary: `Turn: failed (${intent.target.kind})`,
      data: { kind: intent.target.kind, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
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
  pushRosieLog({ source: 'session', level: 'info', summary: `Session: destroyed ${sessionId.slice(0, 12)}…` });
  destroyChannel(sessionId);
  sessions.delete(sessionId);
  // Clean up child session tracking to prevent unbounded map growth.
  // closeSession() can be called directly (e.g. rosie-bot cleanup) outside
  // the normal dispatch/resume cleanup paths that gate on autoClose.
  childSessions.delete(sessionId);
}

// ============================================================================
// Child Session Dispatch — Shared Primitive
// ============================================================================

/**
 * Dispatch an ephemeral child session — fork, hydrated cross-vendor fork, or new — collect result, auto-close.
 *
 * This is the shared primitive for spawning child sessions. Rosie is the
 * first consumer; CLI Dispatch will reuse it later.
 *
 * Routing:
 * - Same vendor, !forceNew → native fork (child sees full transcript)
 * - Cross-vendor, !forceNew → hydrated fork (parent history loaded, converted to universal format)
 * - forceNew → blank new session (no transcript context, used by tracker/recall)
 *
 * Creates an internal subscriber, collects assistant text, waits for idle.
 * Returns { sessionId, text, structured } or null on timeout/error.
 */
export async function dispatchChildSession(
  options: ChildSessionOptions,
): Promise<ChildSessionResult | null> {
  const {
    parentSessionId,
    vendor,
    parentVendor,
    prompt,
    settings = {},
    skipPersistSession = true,
    autoClose = true,
    timeoutMs = 60_000,
  } = options;

  // Get parent's project path for cross-vendor cwd
  const parentInfo = findSession(parentSessionId);
  const cwd = options.cwd ?? parentInfo?.projectPath ?? process.cwd();

  // Common ephemeral options shared by all target kinds
  const ephemeral: EphemeralTargetOptions = {
    skipPersistSession,
    ...(options.mcpServers && { mcpServers: options.mcpServers }),
    ...(options.env && { env: options.env }),
  };

  // Build target: hydrated if caller provided pre-loaded history, fork if same
  // vendor (unless forceNew), hydrated cross-vendor fork if different vendor
  // (unless forceNew), new if forceNew
  let target: TurnTarget;
  if (options.hydratedHistory) {
    // Caller provided pre-loaded, pre-filtered history — use hydrated path directly
    // (bypasses loadHistory, useful for filtered transcripts that strip tool blocks)
    target = {
      kind: 'hydrated', vendor: vendor as Vendor, cwd,
      history: options.hydratedHistory, sourceVendor: parentVendor as Vendor,
      sourceSessionId: parentSessionId,
      ...ephemeral,
    };
  } else if (vendor === parentVendor && !options.forceNew) {
    // Same vendor — native fork (child sees full transcript via vendor's fork mechanism)
    target = { kind: 'fork', vendor: vendor as Vendor, fromSessionId: parentSessionId, ...ephemeral };
  } else if (vendor !== parentVendor && !options.forceNew) {
    // Cross-vendor fork — load parent's history and create a hydrated session
    // so the child sees the full transcript converted to universal format
    const parentReg = adapters.get(parentVendor as Vendor);
    if (parentReg) {
      const history = await parentReg.discovery.loadHistory(parentSessionId);
      target = {
        kind: 'hydrated', vendor: vendor as Vendor, cwd,
        history, sourceVendor: parentVendor as Vendor, sourceSessionId: parentSessionId,
        ...ephemeral,
      };
    } else {
      // Parent vendor not registered — fall back to blank new session
      pushRosieLog({ level: 'warn', source: 'child-session', summary: `No adapter for parent vendor "${parentVendor}" — falling back to blank new session` });
      target = { kind: 'new', vendor: vendor as Vendor, cwd, ...ephemeral };
    }
  } else {
    // forceNew — intentionally blank (no transcript context needed, e.g. tracker/recall)
    target = { kind: 'new', vendor: vendor as Vendor, cwd, ...ephemeral };
  }

  const intent: TurnIntent = {
    target,
    content: prompt,
    clientMessageId: crypto.randomUUID(),
    settings,
  };

  // Allocate a deterministic pending ID up front so cleanup always has a
  // channel reference, even if sendTurn hasn't resolved yet.
  const pendingId = `pending:child-${crypto.randomUUID()}`;

  pushRosieLog({ source: 'session', level: 'info', summary: `Session: dispatching child (${vendor}) for parent ${parentSessionId.slice(0, 12)}…`, data: { parentSessionId, vendor, timeoutMs } });

  return new Promise<ChildSessionResult | null>((resolve) => {
    let text = '';
    let structured: unknown;
    let settled = false;
    // Track the current session ID — starts as the pending ID, may be rekeyed.
    let currentId: string = pendingId;
    // Captured from sendTurn result — used by idle handler for autoClose:false
    let rekeyPromise: Promise<string> | undefined;
    // Idle debounce timer — prevents spurious early resolution (fix #8)
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      if (!settled) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        const parts: string[] = [];
        if (lastError) parts.push(`error: ${lastError}`);
        parts.push(`entries: [${entryTypes.join(', ')}]`);
        if (contentSummaries.length > 0) parts.push(`content: ${contentSummaries.join(', ')}`);
        parts.push(`text: ${text.length} chars`);
        pushRosieLog({ level: 'warn', source: 'child-session', summary: `Timeout after ${timeoutMs}ms — no idle event received (parent: ${parentSessionId}, vendor: ${vendor}) — ${parts.join(' | ')}` });
        settled = true;
        if (text) {
          cleanup();
          pushRosieLog({ level: 'warn', source: 'child-session', summary: `Timeout with partial text (${text.length} chars) -- returning partial result (parent: ${parentSessionId}, vendor: ${vendor})` });
          resolve({ sessionId: currentId, text, structured });
        } else {
          // No text → caller gets null and has no session ID to clean up.
          // Force-close to prevent leaking channel+adapter+MCP subprocesses.
          cleanup(/* force */ true);
          resolve(null);
        }
      }
    }, timeoutMs);

    // force=true tears down even when autoClose:false — used when the dispatch
    // resolves null (no session ID returned to caller → unreachable channel).
    const cleanup = (force = false) => {
      clearTimeout(timer);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const shouldClose = autoClose || force;
      // Clean up both pendingId and currentId to handle the rekey race —
      // if timeout fires mid-rekey, currentId may differ from pendingId.
      for (const id of new Set([pendingId, currentId])) {
        const ch = getChannel(id);
        if (ch) {
          unsubscribe(ch, internalSubscriber);
          if (shouldClose) {
            closeSession(id);
          }
        }
        // Only remove child tracking when closing. For autoClose: false (no force),
        // the child stays alive for resumeChildSession — isChildSession() must
        // still recognize it to prevent lifecycle hooks from firing on it.
        if (shouldClose) {
          childSessions.delete(id);
        }
      }
    };

    // Diagnostics: track what the child session produced so failures are
    // immediately self-explanatory (no inference needed).
    const entryTypes: string[] = [];
    let lastError: string | undefined;
    /** Per-entry content block types, e.g. "assistant:[tool_use,tool_use]" or "result:[text]" */
    const contentSummaries: string[] = [];
    let streamingDots = false;

    const internalSubscriber: Subscriber = {
      id: `child-${crypto.randomUUID()}`,
      send(msg) {
        if (settled) return;

        // Skip catchup messages
        if (msg.type === 'catchup') return;

        // Log every message type for diagnostics
        if (msg.type === 'event') {
          const evt = msg.event;
          // Streaming content is too noisy — print label once then dots
          if (evt.type === 'notification' && (evt as { kind?: string }).kind === 'streaming_content') {
            if (!streamingDots) {
              process.stderr.write(`[child-session] Event: notification/streaming_content (parent: ${parentSessionId}) `);
              streamingDots = true;
            }
            process.stderr.write('.');
          } else {
            if (streamingDots) { process.stderr.write('\n'); streamingDots = false; }
            pushRosieLog({ level: 'debug', source: 'child-session', summary: `Event: ${evt.type}${evt.type === 'status' ? `=${(evt as { status?: string }).status}` : evt.type === 'notification' ? `/${(evt as { kind?: string }).kind}` : ''} (parent: ${parentSessionId})` });
          }
        } else if (msg.type === 'entry') {
          if (streamingDots) { process.stderr.write('\n'); streamingDots = false; }
          pushRosieLog({ level: 'debug', source: 'child-session', summary: `Entry: ${msg.entry.type} (parent: ${parentSessionId})` });
        }

        // Track error notifications from the adapter (SDK failures, auth errors, etc.)
        if (msg.type === 'event' && msg.event.type === 'notification' && msg.event.kind === 'error') {
          lastError = (msg.event as { error?: string }).error ?? 'unknown error';
          pushRosieLog({ level: 'error', source: 'child-session', summary: `Error notification: ${lastError} (parent: ${parentSessionId})` });
        }

        // Collect response text and structured output from entry messages.
        // Check both 'assistant' and 'result' entries — with outputFormat the
        // SDK may surface structured output on the result rather than (or in
        // addition to) the assistant message.
        if (msg.type === 'entry') {
          const entry = msg.entry;
          entryTypes.push(entry.type);
          if ((entry.type === 'assistant' || entry.type === 'result') && entry.message) {
            const content = entry.message.content;
            // Track content block types for diagnostics (e.g. "assistant:[tool_use,text]")
            if (Array.isArray(content)) {
              const blockTypes = content.map((b: { type?: string }) => b.type ?? '?');
              contentSummaries.push(`${entry.type}:[${blockTypes.join(',')}]`);
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  text += block.text;
                }
              }
            } else if (typeof content === 'string') {
              contentSummaries.push(`${entry.type}:string(${content.length})`);
              text += content;
            } else {
              contentSummaries.push(`${entry.type}:no-content`);
            }
          }
          // Check structured_output on any entry type — the SDK may attach it
          // to either the assistant or result entry depending on version/mode.
          if (entry.metadata?.structured_output !== undefined) {
            structured = entry.metadata.structured_output;
          }
        }

        // Idle debounce: wait IDLE_SETTLE_MS after idle before resolving.
        // Cancels if 'active' fires (agent starting another tool round).
        // Prevents spurious early resolution in multi-step agent work (fix #8).
        if (msg.type === 'event' && msg.event.type === 'status' && msg.event.status === 'active') {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        }

        // Turn complete — debounced idle resolution
        if (msg.type === 'event' && msg.event.type === 'status' && msg.event.status === 'idle') {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

            // For autoClose:false children, ensure we return the real (rekeyed) ID
            // so resumeChildSession can find the channel. Idle can fire before the
            // rekey promise resolves, leaving currentId as the stale pending ID.
            const finalize = (resolvedId: string) => {
              if (text || structured !== undefined || entryTypes.length > 1) {
                cleanup();
                resolve({ sessionId: resolvedId, text, structured });
              } else {
                const parts: string[] = [];
                if (lastError) parts.push(`error: ${lastError}`);
                parts.push(`entries: [${entryTypes.join(', ')}]`);
                if (contentSummaries.length > 0) parts.push(`content: ${contentSummaries.join(', ')}`);
                pushRosieLog({ level: 'warn', source: 'child-session', summary: `Turn completed with empty response (parent: ${parentSessionId}) — ${parts.join(' | ')}` });
                cleanup(/* force */ true);
                resolve(null);
              }
            };

            if (!autoClose && rekeyPromise) {
              rekeyPromise.then((realId) => {
                childSessions.delete(pendingId);
                childSessions.set(realId, { parentSessionId, autoClose, visible: false });
                finalize(realId);
              }).catch(() => finalize(currentId));
            } else {
              finalize(currentId);
            }
          }, IDLE_SETTLE_MS);
        }
      },
    };

    // Register the pending ID as a child session before sendTurn so cleanup
    // always has something to work with.
    childSessions.set(pendingId, { parentSessionId, autoClose, visible: false });

    // Fire the turn with the explicit pending ID
    pushRosieLog({ level: 'debug', source: 'child-session', summary: `Sending turn (parent: ${parentSessionId}, vendor: ${vendor}, pending: ${pendingId})` });
    sendTurn(intent, internalSubscriber, pendingId)
      .then((result) => {
        if (settled) return;
        pushRosieLog({ level: 'debug', source: 'child-session', summary: `sendTurn resolved — sessionId: ${result.sessionId} (parent: ${parentSessionId})` });
        currentId = result.sessionId;
        // Migrate child tracking from pending to real ID
        childSessions.delete(pendingId);
        childSessions.set(currentId, { parentSessionId, autoClose, visible: false });

        // Handle pending->real ID re-keying
        if (result.rekeyPromise) {
          rekeyPromise = result.rekeyPromise;
          result.rekeyPromise.then((realId) => {
            if (settled) return;
            childSessions.delete(currentId);
            childSessions.set(realId, { parentSessionId, autoClose, visible: false });
            currentId = realId;
          }).catch(() => {});
        }
      })
      .catch((err) => {
        if (!settled) {
          pushRosieLog({ level: 'warn', source: 'child-session', summary: `sendTurn failed (parent: ${parentSessionId}, vendor: ${vendor}): ${err instanceof Error ? err.message : String(err)}` });
          pushRosieLog({ source: 'session', level: 'error', summary: `Session: child dispatch failed (${vendor})`, data: { parentSessionId, vendor, error: err instanceof Error ? err.message : String(err) } });
          settled = true;
          // Force-close: caller gets null, no way to clean up the child.
          cleanup(/* force */ true);
          resolve(null);
        }
      });
  });
}

// ============================================================================
// Resume Child Session
// ============================================================================

export interface ResumeChildOptions {
  /** The session ID returned by dispatchChildSession (the resolved real ID). */
  sessionId: string;
  /** Message content for the follow-up turn. */
  prompt: MessageContent;
  /** Turn settings for this turn (model, permissionMode, etc.). */
  settings?: TurnSettings;
  /** Auto-close the channel after this turn completes (default: true). */
  autoClose?: boolean;
  /** Timeout in ms (default: 60000). */
  timeoutMs?: number;
}

/**
 * Send a follow-up turn to an existing child session that was dispatched with
 * `autoClose: false`. Reuses the open channel — no session creation or rekey.
 *
 * Returns the collected result (text + structured), or null on failure/timeout.
 */
export async function resumeChildSession(
  options: ResumeChildOptions,
): Promise<ChildSessionResult | null> {
  const {
    sessionId,
    prompt,
    settings = {},
    autoClose = true,
    timeoutMs = 60_000,
  } = options;

  const ch = getChannel(sessionId);
  if (!ch) {
    pushRosieLog({ level: 'warn', source: 'resume-child', summary: `No channel found for session ${sessionId}` });
    return null;
  }

  // Defensive: ensure childSessions tracks this session to prevent lifecycle
  // hooks from firing on it during turn 2.
  if (!childSessions.has(sessionId)) {
    childSessions.set(sessionId, { parentSessionId: '', autoClose, visible: false });
  }

  const intent: TurnIntent = {
    target: { kind: 'existing', sessionId },
    content: prompt,
    clientMessageId: crypto.randomUUID(),
    settings,
  };

  pushRosieLog({ source: 'session', level: 'info', summary: `Session: resuming child ${sessionId.slice(0, 12)}…`, data: { sessionId, timeoutMs } });

  return new Promise<ChildSessionResult | null>((resolve) => {
    let text = '';
    let structured: unknown;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const timer = setTimeout(() => {
      if (!settled) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        pushRosieLog({ level: 'warn', source: 'resume-child', summary: `Timeout after ${timeoutMs}ms — session ${sessionId}` });
        settled = true;
        cleanup();
        if (text) {
          resolve({ sessionId, text, structured });
        } else {
          resolve(null);
        }
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const ch = getChannel(sessionId);
      if (ch) {
        unsubscribe(ch, internalSubscriber);
        if (autoClose) {
          closeSession(sessionId);
        }
      }
      if (autoClose) {
        childSessions.delete(sessionId);
      } else {
        // Update autoClose tracking for the next resume
        const entry = childSessions.get(sessionId);
        if (entry) {
          childSessions.set(sessionId, { ...entry, autoClose });
        }
      }
    };

    const entryTypes: string[] = [];
    let lastError: string | undefined;

    const internalSubscriber: Subscriber = {
      id: `resume-${crypto.randomUUID()}`,
      send(msg) {
        if (settled) return;
        if (msg.type === 'catchup') return;

        // Track errors
        if (msg.type === 'event' && msg.event.type === 'notification' && msg.event.kind === 'error') {
          lastError = (msg.event as { error?: string }).error ?? 'unknown error';
        }

        // Collect response text and structured output
        if (msg.type === 'entry') {
          const entry = msg.entry;
          entryTypes.push(entry.type);
          if ((entry.type === 'assistant' || entry.type === 'result') && entry.message) {
            const content = entry.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  text += block.text;
                }
              }
            } else if (typeof content === 'string') {
              text += content;
            }
          }
          if (entry.metadata?.structured_output !== undefined) {
            structured = entry.metadata.structured_output;
          }
        }

        // Idle debounce (fix #8)
        if (msg.type === 'event' && msg.event.type === 'status' && msg.event.status === 'active') {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        }

        // Turn complete — debounced
        if (msg.type === 'event' && msg.event.type === 'status' && msg.event.status === 'idle') {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            if (text || structured !== undefined || entryTypes.length > 1) {
              resolve({ sessionId, text, structured });
            } else {
              if (lastError) pushRosieLog({ level: 'warn', source: 'resume-child', summary: `Empty response with error: ${lastError}` });
              resolve(null);
            }
          }, IDLE_SETTLE_MS);
        }
      },
    };

    // Subscribe to the existing channel
    subscribe(ch, internalSubscriber);

    // Send the turn — no pending ID needed, session already exists
    sendTurn(intent, internalSubscriber)
      .then(() => {
        if (settled) return;
        pushRosieLog({ level: 'debug', source: 'resume-child', summary: `sendTurn resolved for ${sessionId}` });
      })
      .catch((err) => {
        if (!settled) {
          pushRosieLog({ level: 'warn', source: 'resume-child', summary: `sendTurn failed: ${err instanceof Error ? err.message : String(err)}` });
          settled = true;
          cleanup();
          resolve(null);
        }
      });
  });
}
