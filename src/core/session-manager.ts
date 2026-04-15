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

// ---------------------------------------------------------------------------
// Host socket path — set by host layer so buildSessionEnv() can inject
// CRISPY_SOCK without importing host code.
// ---------------------------------------------------------------------------
let hostSocketPath = '';
export function setHostSocketPath(path: string): void { hostSocketPath = path; }

// ---------------------------------------------------------------------------
// Tool env vars — set by adapter-registry so buildSessionEnv() can inject
// tool paths (RECALL_CLI, CRISPY_DISPATCH, etc.) without polluting process.env.
// ---------------------------------------------------------------------------
let toolEnv: Record<string, string> = {};
export function setToolEnv(env: Record<string, string>): void { toolEnv = env; }

// ---------------------------------------------------------------------------
// Default session CWD — set by host layer so core never calls process.cwd().
// In VS Code this is the workspace folder; in daemon mode it's $HOME.
// ---------------------------------------------------------------------------
let defaultCwd = '';
export function setDefaultCwd(cwd: string): void { defaultCwd = cwd; }

import type { AgentAdapter, VendorDiscovery, SessionInfo, SessionOpenSpec, ChannelMessage, TurnIntent, TurnTarget, TurnSettings, SubagentEntriesResult, EphemeralTargetOptions, LocalPlugin } from './agent-adapter.js';
import type { ArbiterPolicy } from './arbiter/types.js';
import type { TranscriptEntry, MessageContent, Vendor, Usage } from './transcript.js';
import type { SessionChannel, Subscriber, SubscriberMessage } from './session-channel.js';
import { parseModelOption } from './model-utils.js';
import { normalizePath } from './url-path-resolver.js';

import {
  createChannel, setAdapter, subscribe, unsubscribe,
  destroyChannel, rekeyChannel, getChannel, rotateAdapter,
  broadcastUserEntry as channelBroadcastUserEntry,
  broadcastEvent,
} from './session-channel.js';
import { refreshAndNotify, notifyStatusChange, broadcastCloseChannel, broadcastOpenChannel } from './session-list-manager.js';
import { fireResponseComplete } from './lifecycle-hooks.js';
import { log } from './log.js';
import { isSystemSession, setSessionKind } from './activity-index.js';
import { getRemoteSessions } from './remote-proxy.js';

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
  /** Plugins to attach to the child session (Claude SDK plugins option). */
  plugins?: LocalPlugin[];
  /** Environment overrides for the child session. */
  env?: Record<string, string>;
  /** Explicit working directory — overrides parent session's projectPath. */
  cwd?: string;
  /** System prompt override for the child session. */
  systemPrompt?: string;
  /** Whether this is a user-initiated or system-initiated session. */
  sessionKind?: 'user' | 'system';
  /** Open a visible tab/panel for this child session. */
  openChannel?: boolean;
  /** Called for each channel message — use for streaming log output. */
  onEntry?: (msg: ChannelMessage) => void;
  /** Arbiter policy for automatic tool call gating on the child channel. */
  arbiterPolicy?: ArbiterPolicy;
}

export interface ChildSessionResult {
  sessionId: string;
  text: string;
  structured?: unknown;
  contextUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    totalCostUsd?: number;
  };
}

/** Extract contextUsage from a channel's adapter for inclusion in ChildSessionResult. */
function extractChildContextUsage(channelId: string): ChildSessionResult['contextUsage'] | undefined {
  const ch = getChannel(channelId);
  const usage = ch?.adapter?.contextUsage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.tokens.input,
    outputTokens: usage.tokens.output,
    cacheReadTokens: usage.tokens.cacheRead || undefined,
    totalCostUsd: usage.totalCostUsd,
  };
}

/** Accumulated per-entry token usage from child session subscribers. */
interface ChildTokenAccumulator {
  input: number;
  output: number;
  cacheRead: number;
}

/** Cost delta: adapter cost minus baseline, undefined when non-positive. */
function costDelta(adapterCostUsd: number | undefined, baseline: number | undefined): number | undefined {
  if (baseline === undefined) return adapterCostUsd;
  const delta = (adapterCostUsd ?? 0) - baseline;
  return delta > 0 ? delta : undefined;
}

/** Accumulate per-entry token usage from a non-sub-agent assistant entry. */
function accumulateEntryUsage(entry: { type: string; parentToolUseID?: string; message?: { usage?: Usage } }, acc: ChildTokenAccumulator): void {
  if (entry.type !== 'assistant' || entry.parentToolUseID || !entry.message?.usage) return;
  const u = entry.message.usage;
  acc.input += u.input_tokens ?? 0;
  acc.output += u.output_tokens ?? 0;
  acc.cacheRead += (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/**
 * Build accurate contextUsage for child sessions by preferring accumulated
 * per-entry usage over adapter snapshot fallbacks.
 *
 * Claude entries carry per-turn usage → sum entries for accurate totals.
 * Vendors without trustworthy per-entry usage fall back to the adapter snapshot.
 */
function buildChildUsage(
  channelId: string,
  acc: ChildTokenAccumulator,
  baselineCostUsd?: number,
): ChildSessionResult['contextUsage'] | undefined {
  const adapterUsage = extractChildContextUsage(channelId);
  if (acc.input + acc.output > 0) {
    return {
      inputTokens: acc.input,
      outputTokens: acc.output,
      cacheReadTokens: acc.cacheRead || undefined,
      totalCostUsd: costDelta(adapterUsage?.totalCostUsd, baselineCostUsd),
    };
  }
  // Fallback: adapter snapshot (Codex cumulative / OpenCode / unknown vendors)
  return adapterUsage;
}

/** Parent->child relationship tracking. Used by dispatchChildSession for lifecycle management.
 *  `visible` sessions get session-list notifications (appear in editor UI) but still
 *  skip lifecycle hooks (Rosie won't process them). */
const childSessions = new Map<string, {
  parentSessionId: string;
  autoClose: boolean;
  visible: boolean;
  closed?: boolean;
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
  meta: { parentSessionId: string; autoClose: boolean; visible: boolean; closed?: boolean },
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
 * List child sessions spawned by a parent session.
 * Returns all children (including closed ones) so callers can read transcripts.
 * Filters out pending:* IDs that haven't been rekeyed yet.
 */
export function listChildSessions(parentSessionId: string): Array<{
  sessionId: string;
  visible: boolean;
  autoClose: boolean;
  closed: boolean;
}> {
  const results: Array<{ sessionId: string; visible: boolean; autoClose: boolean; closed: boolean }> = [];
  for (const [id, meta] of childSessions) {
    if (meta.parentSessionId === parentSessionId && !id.startsWith('pending:')) {
      results.push({
        sessionId: id,
        visible: meta.visible,
        autoClose: meta.autoClose,
        closed: !!meta.closed,
      });
    }
  }
  return results;
}

/**
 * List all currently-open visible child sessions (visible=true, not closed).
 * Used by session-list-manager to replay open-channel events on subscribe,
 * so reconnecting clients (e.g. Tauri via WSL WebSocket) recover missed events.
 */
export function getOpenVisibleChildren(): Array<{
  sessionId: string;
  autoClose: boolean;
}> {
  const results: Array<{ sessionId: string; autoClose: boolean }> = [];
  for (const [id, meta] of childSessions) {
    if (meta.visible && !meta.closed && !id.startsWith('pending:')) {
      results.push({ sessionId: id, autoClose: meta.autoClose });
    }
  }
  return results;
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
  toolEnv = {};
  defaultCwd = '';
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
  const resolved = resolveSessionPrefix(resolveSessionId(sessionId));
  for (const { discovery } of adapters.values()) {
    const info = discovery.findSession(resolved);
    if (info) {
      // Enrich with sessionKind so consumers (webview, session list) can reason about it
      if (info.sessionKind === undefined && isSystemSession(resolved)) {
        return { ...info, sessionKind: 'system' };
      }
      return info;
    }
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
  // Merge sessions from remote daemons (e.g. WSL proxy)
  all.push(...getRemoteSessions());
  const result = all
    .filter(s => !s.isSidechain && !isSystemSession(s.sessionId))
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
 * Attach a one-shot subscriber that notifies the session list when the
 * real session ID resolves (via session_changed event). Used by
 * createPendingChannel() and switchSession() fresh mode.
 */
function attachListNotifySubscriber(channel: SessionChannel, id: string): void {
  const sub: Subscriber = {
    id: `__list_notify__${id}`,
    send(msg) {
      if (isSessionChangedEvent(msg)) {
        refreshAndNotify(msg.event.sessionId);
        unsubscribe(channel, sub);
      }
    },
  };
  subscribe(channel, sub);
}

/**
 * Wire lifecycle hooks on a channel — onIdle and onStatusChange.
 *
 * Shared by openChannel() and switchSession(). The closures read
 * channel.adapter?.sessionId at call time, so they automatically
 * pick up the current adapter after rotation.
 */
function wireLifecycleHooks(channel: SessionChannel): void {
  channel.onIdle = () => {
    const sessionId = channel.adapter?.sessionId;
    if (!sessionId) return;
    const childMeta = childSessions.get(sessionId);
    if (childMeta && !childMeta.visible) return;
    if (childMeta?.visible) {
      setTimeout(() => {
        const currentId = channel.adapter?.sessionId ?? sessionId;
        refreshAndNotify(currentId);
        if (childMeta.autoClose) {
          broadcastCloseChannel(currentId);
          closeSession(currentId);
          const meta1 = childSessions.get(currentId);
          if (meta1) childSessions.set(currentId, { ...meta1, closed: true });
          if (currentId !== sessionId) {
            const meta2 = childSessions.get(sessionId);
            if (meta2) childSessions.set(sessionId, { ...meta2, closed: true });
          }
        }
      }, 150);
      return;
    }
    setTimeout(() => {
      refreshAndNotify(sessionId);
      fireResponseComplete(sessionId);
    }, 150);
  };

  channel.onStatusChange = (state) => {
    const sessionId = channel.adapter?.sessionId;
    if (!sessionId) return;
    const childMeta = childSessions.get(sessionId);
    if (childMeta && !childMeta.visible) return;
    notifyStatusChange(sessionId, state);
  };
}

/**
 * Create a channel for a session using a factory-created adapter.
 * Internal — not exported. Uses sessionId as channelId (1:1 mapping).
 *
 * Each channel gets its own adapter instance from the vendor's factory,
 * so multiple live sessions per vendor are fully supported.
 */
function openChannel(
  channelId: string,
  vendor: Vendor,
  spec: SessionOpenSpec,
  options?: { initialEntries?: TranscriptEntry[] },
): SessionChannel {
  const registration = adapters.get(vendor);
  if (!registration) {
    throw new Error(`No adapter registered for vendor "${vendor}".`);
  }

  const liveAdapter = registration.createAdapter(spec);
  const channel = createChannel(channelId, options?.initialEntries);

  wireLifecycleHooks(channel);
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
 * Build the env block for a managed session, injecting CRISPY_SESSION_ID
 * and CRISPY_SOCK so child processes can self-identify and IPC-connect
 * back to this host.
 */
function buildSessionEnv(sessionId: string, extraEnv?: Record<string, string>): Record<string, string> {
  return {
    ...toolEnv,
    ...extraEnv,
    CRISPY_SESSION_ID: sessionId,
    ...(hostSocketPath && { CRISPY_SOCK: hostSocketPath }),
  };
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

  // Inject CRISPY_SESSION_ID + CRISPY_SOCK so LLMs in managed sessions can
  // self-identify and IPC-connect back to this host. For resume, the real
  // session ID is already known; for fresh/fork, use the pending ID (resolved
  // later via resolveSessionId()).
  const envSessionId = spec.mode === 'resume' ? spec.sessionId! : pendingId;
  spec = { ...spec, env: buildSessionEnv(envSessionId, spec.env) };

  const channel = openChannel(pendingId, vendor, spec, {
    initialEntries: options?.entries,
  });
  sessions.set(pendingId, channel);

  // Subscribe — catchup uses channel-owned entries
  subscribe(channel, subscriber);

  // One-shot session-list notifier: pushes upsert when the real session ID resolves
  attachListNotifySubscriber(channel, pendingId);

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
          log({ source: 'session', level: 'info', summary: `Session: re-keyed ${pendingId.slice(0, 20)}… → ${realId.slice(0, 12)}…`, data: { pendingId, realId } });
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
      log({ source: 'session', level: 'error', summary: `Re-key timeout: ${pendingId.slice(0, 20)}… (15s)`, data: { pendingId } });
      destroyChannel(pendingId);
      sessions.delete(pendingId);
      reject(new Error(`Fork timed out: session re-key did not complete within 15 seconds (${pendingId})`));
    }, 15_000);
  });

  return { pendingId, channel, rekeyPromise };
}

// ============================================================================
// Session Rotation
// ============================================================================

/** Result from rotating a session on an existing channel. */
export interface RotateSessionResult {
  previousSessionId: string;
  pendingId: string;
  channel: SessionChannel;
  rekeyPromise: Promise<string>;
}

/**
 * Rotate the session — swap the adapter on the channel, rekey to the
 * new session ID, preserve the old session in the session list.
 *
 * The channel object survives with all its subscribers. Old entries are
 * flushed, the old session is preserved, and a new session begins
 * streaming into the same channel.
 */
export async function switchSession(
  currentSessionId: string,
  vendor: Vendor,
  spec: SessionOpenSpec,
): Promise<RotateSessionResult> {
  if (currentSessionId.startsWith('pending:')) {
    throw new Error('Cannot rotate a session that is still initializing.');
  }

  // If resume target already has a channel, detach it so this one can take over.
  // This happens when a previous switch left a stale channel attached, or when
  // multiple clients race to open the same session.
  if (spec.mode === 'resume' && sessions.has(spec.sessionId)) {
    const staleChannel = sessions.get(spec.sessionId)!;
    await rotateAdapter(staleChannel);
    destroyChannel(spec.sessionId);
    sessions.delete(spec.sessionId);
  }

  const channel = requireChannel(currentSessionId);
  const previousSessionId = channel.adapter?.sessionId ?? currentSessionId;

  // Capture current adapter settings before rotation destroys the adapter.
  // These become defaults for the new session — caller-provided values take precedence.
  const inheritedSettings = channel.adapter?.settings;

  // Close old adapter, flush entries, reset state
  await rotateAdapter(channel);

  // Fire old-session lifecycle hooks (same 150ms delay as openChannel's onIdle)
  setTimeout(() => {
    refreshAndNotify(previousSessionId);
    fireResponseComplete(previousSessionId);
  }, 150);

  // Resume mode: skip the pending ID dance — use the real target ID directly.
  // Resumed sessions pre-seed _sessionId, so session_changed never fires and
  // the pending→real rekey would time out. Instead, rekey straight to the
  // target ID and return an already-resolved rekeyPromise.
  if (spec.mode === 'resume') {
    const realId = spec.sessionId;

    rekeyChannel(currentSessionId, realId);
    sessions.delete(currentSessionId);
    sessions.set(realId, channel);

    // Inject env with the REAL session ID (not a pending one)
    spec = { ...spec, env: buildSessionEnv(realId, spec.env) };

    const registration = adapters.get(vendor);
    if (!registration) throw new Error(`No adapter registered for vendor "${vendor}".`);

    // Load history so the channel has entries for subscriber catchup.
    // rotateAdapter() flushed channel.entries — we must re-seed them.
    const history = await registration.discovery.loadHistory(realId);
    channel.entries = history;
    channel.entryIndex = history.length;

    // Notify all subscribers (including other clients like the webview) that
    // this channel switched to a different session. Emitted AFTER history
    // loading so catchup has entries when the webview re-subscribes.
    // Subscribers still receive this tagged with the old sessionId (their
    // send() closure captured it at subscribe time), so the webview's
    // session_changed handler in SessionContext.tsx matches and updates
    // selectedSessionId correctly.
    broadcastEvent(channel, {
      type: 'notification',
      kind: 'session_changed',
      sessionId: realId,
      previousSessionId: currentSessionId,
    });

    const newAdapter = registration.createAdapter(spec);

    wireLifecycleHooks(channel);
    setAdapter(channel, newAdapter);

    // For resume, session_changed won't fire (adapter pre-seeds _sessionId),
    // so notify the session list directly instead of subscribing a one-shot.
    refreshAndNotify(realId);

    return {
      previousSessionId,
      pendingId: realId,
      channel,
      rekeyPromise: Promise.resolve(realId),
    };
  }

  // Fresh mode: generate pending ID and rekey channel
  const pendingId = `pending:${crypto.randomUUID()}`;
  rekeyChannel(currentSessionId, pendingId);
  sessions.delete(currentSessionId);
  sessions.set(pendingId, channel);

  // Inherit settings from previous adapter (caller-provided values win)
  if (inheritedSettings && spec.mode === 'fresh') {
    type FreshSpec = Extract<SessionOpenSpec, { mode: 'fresh' }>;
    spec = {
      ...spec,
      model: spec.model ?? inheritedSettings.model,
      permissionMode: spec.permissionMode ?? inheritedSettings.permissionMode as FreshSpec['permissionMode'],
      allowDangerouslySkipPermissions: spec.allowDangerouslySkipPermissions ?? inheritedSettings.allowDangerouslySkipPermissions,
      extraArgs: spec.extraArgs ?? inheritedSettings.extraArgs,
    };
  }

  // Inject env (CRISPY_SESSION_ID + CRISPY_SOCK)
  spec = { ...spec, env: buildSessionEnv(pendingId, spec.env) };

  // Create new adapter
  const registration = adapters.get(vendor);
  if (!registration) {
    throw new Error(`No adapter registered for vendor "${vendor}".`);
  }
  const newAdapter = registration.createAdapter(spec);

  // Re-wire lifecycle hooks (same closures as openChannel — reads adapter.sessionId at call time)
  wireLifecycleHooks(channel);

  // Install new adapter — starts consumption loop
  setAdapter(channel, newAdapter);

  // One-shot list-notify subscriber (same pattern as createPendingChannel)
  attachListNotifySubscriber(channel, pendingId);

  // One-shot rekey subscriber (pending → real)
  const rekeyPromise = new Promise<string>((resolve, reject) => {
    let settled = false;
    const rekeySubscriber: Subscriber = {
      id: `__rekey__${pendingId}`,
      send(msg) {
        if (isSessionChangedEvent(msg)) {
          settled = true;
          const realId = msg.event.sessionId;
          rekeyChannel(pendingId, realId);
          log({ source: 'session', level: 'info', summary: `Session rotation: re-keyed ${pendingId.slice(0, 20)}… → ${realId.slice(0, 12)}…`, data: { pendingId, realId } });
          sessions.delete(pendingId);
          sessions.set(realId, channel);
          pendingToReal.set(pendingId, realId);
          unsubscribe(channel, rekeySubscriber);
          resolve(realId);
        }
      },
    };
    subscribe(channel, rekeySubscriber);

    setTimeout(() => {
      if (settled) return;
      unsubscribe(channel, rekeySubscriber);
      log({ source: 'session', level: 'error', summary: `Rotation re-key timeout: ${pendingId.slice(0, 20)}… (15s)`, data: { pendingId } });
      reject(new Error(`Rotation timed out: session re-key did not complete within 15 seconds (${pendingId})`));
    }, 15_000);
  });

  return { previousSessionId, pendingId, channel, rekeyPromise };
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
    // Channel already has entries in memory — just subscribe (catchup delivers them)
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

      // Load history BEFORE opening the channel so entries are seeded
      // before the consumption loop starts (prevents seeding race).
      const reg = adapters.get(info.vendor)!;
      let entries = await reg.discovery.loadHistory(sessionId);
      // Apply truncation if specified
      if (until) {
        const cutIdx = entries.findIndex(e => e.uuid === until);
        if (cutIdx !== -1) {
          entries = entries.slice(0, cutIdx + 1);
        } else {
          log({ source: 'session', level: 'warn', summary: 'Fork truncation UUID not found, loading full history', data: { sessionId, until } });
        }
      }

      const ch = openChannel(sessionId, info.vendor, {
        mode: 'resume', sessionId,
        env: buildSessionEnv(sessionId),
      }, {
        initialEntries: entries,
      });
      sessions.set(sessionId, ch);

      return ch;
    })();

    pending.set(sessionId, init);
    try {
      channel = await init;
    } finally {
      pending.delete(sessionId);
    }
  }
  // Existing channel: entries are already in memory — catchup delivers them.

  subscribe(channel, subscriber);
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
  options?: { model?: string; permissionMode?: TurnSettings['permissionMode']; allowDangerouslySkipPermissions?: boolean; extraArgs?: Record<string, string | null>; skipPersistSession?: boolean; mcpServers?: Record<string, unknown>; env?: Record<string, string>; systemPrompt?: string; sessionKind?: 'user' | 'system' },
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
    ...(options?.allowDangerouslySkipPermissions && { allowDangerouslySkipPermissions: true }),
    ...(options?.extraArgs && { extraArgs: options.extraArgs }),
    ...(options?.skipPersistSession && { skipPersistSession: true }),
    ...(options?.mcpServers && { mcpServers: options.mcpServers }),
    ...(options?.env && { env: options.env }),
    ...(options?.systemPrompt && { systemPrompt: options.systemPrompt }),
    ...(options?.sessionKind && { sessionKind: options.sessionKind }),
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
    sessionKind?: 'user' | 'system';
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

      log({ source: 'session', level: 'info', summary: `Pre-fork materialized: ${realId.slice(0, 12)}…`, data: { fromSessionId, realId } });

      // Load fork history before opening — the Claude adapter skips replayed
      // messages (isMessageReplayed guard), so history is never re-emitted
      // through the consumption loop. Without seeding, the user sees an
      // empty transcript after fork until the first live entry arrives.
      const forkEntries = await reg.discovery.loadHistory(realId);

      // Open channel with real ID directly — no pending prefix, no re-key
      const spec: SessionOpenSpec = {
        mode: 'resume',
        sessionId: realId,
        env: buildSessionEnv(realId),
        ...(options?.settings?.permissionMode && { permissionMode: options.settings.permissionMode }),
      };
      const channel = openChannel(realId, vendor, spec, {
        initialEntries: forkEntries,
      });
      sessions.set(realId, channel);
      subscribe(channel, subscriber);

      // Notify session list of the new session
      refreshAndNotify(realId);

      // Return a resolved rekeyPromise since the ID is already real
      return { pendingId: realId, channel, rekeyPromise: Promise.resolve(realId) };
    } catch (err) {
      log({ source: 'session', level: 'warn', summary: `Pre-fork failed, falling back to pending channel`, data: { fromSessionId, error: String(err) } });
      // Fall through to legacy fork path
    }
  }

  // Legacy fork path: pending channel with re-key.
  // Pre-load parent history so the channel starts with the fork's transcript
  // visible — otherwise the channel is empty until live entries arrive.
  let forkEntries: TranscriptEntry[] | undefined;
  try {
    forkEntries = await reg.discovery.loadHistory(fromSessionId);
    if (options?.atMessageId) {
      const cutIdx = forkEntries.findIndex(e => e.uuid === options.atMessageId);
      if (cutIdx !== -1) forkEntries = forkEntries.slice(0, cutIdx + 1);
    }
  } catch (err) {
    log({ source: 'session', level: 'warn', summary: `Failed to pre-load fork history`, data: { fromSessionId, error: String(err) } });
  }

  const spec: SessionOpenSpec = {
    mode: 'fork',
    fromSessionId,
    ...(options?.atMessageId && { atMessageId: options.atMessageId }),
    ...(options?.settings?.model && { model: options.settings.model }),
    ...(options?.settings?.permissionMode && { permissionMode: options.settings.permissionMode }),
    ...(options?.settings?.allowDangerouslySkipPermissions && { allowDangerouslySkipPermissions: true }),
    ...(options?.settings?.outputFormat && { outputFormat: options.settings.outputFormat }),
    ...(options?.skipPersistSession && { skipPersistSession: true }),
    ...(options?.mcpServers && { mcpServers: options.mcpServers }),
    ...(options?.env && { env: options.env }),
    ...(options?.systemPrompt && { systemPrompt: options.systemPrompt }),
    ...(options?.sessionKind && { sessionKind: options.sessionKind }),
  };

  return createPendingChannel(vendor, spec, subscriber, {
    explicitPendingId,
    entries: forkEntries,
  });
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

      // Check for vendor switch via the model field.
      // Use != null (not truthiness) — Claude "Default" sends model='' which
      // is falsy but still a valid vendor selection (parseModelOption('') → claude).
      if (intent.target.model != null && currentVendor) {
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
            cwd: normalizePath(sourceInfo?.projectPath ?? defaultCwd),
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
      // Resolve CWD: explicit cwd > parent session's projectPath > host default
      let cwd = intent.target.cwd;
      if (!cwd && intent.target.parentSessionId) {
        const parentInfo = findSession(intent.target.parentSessionId);
        if (parentInfo?.projectPath) cwd = normalizePath(parentInfo.projectPath);
      }
      if (!cwd) cwd = normalizePath(defaultCwd);

      const created = createSession(
        intent.target.vendor as Vendor,
        cwd,
        subscriber,
        {
          ...intent.settings,
          ...(intent.target.skipPersistSession && { skipPersistSession: true }),
          ...(intent.target.mcpServers && { mcpServers: intent.target.mcpServers }),
          ...(intent.target.env && { env: intent.target.env }),
          ...(intent.target.systemPrompt && { systemPrompt: intent.target.systemPrompt }),
          ...(intent.target.sessionKind && { sessionKind: intent.target.sessionKind }),
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
          ...(intent.target.sessionKind && { sessionKind: intent.target.sessionKind }),
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
        ...(intent.target.sessionKind && { sessionKind: intent.target.sessionKind }),
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

  // Visibility: broadcast open channel event so the UI creates a tab.
  if (intent.openChannel) {
    const displayName = typeof intent.content === 'string'
      ? intent.content.slice(0, 80)
      : undefined;

    if (rekeyPromise) {
      rekeyPromise.then((realId) => {
        refreshAndNotify(realId);
        broadcastOpenChannel(realId, displayName, intent.autoClose);
      }).catch((err) => {
        log({ source: 'session', level: 'error', summary: `openChannel broadcast skipped: rekey failed for ${sessionId.slice(0, 20)}…`, data: { error: String(err) } });
      });
    } else {
      refreshAndNotify(sessionId);
      broadcastOpenChannel(sessionId, displayName, intent.autoClose);
    }
  }

  // Child registration for IPC-dispatched sessions (crispy-dispatch → sendTurn).
  // dispatchChildSession manages its own childSessions map — only the IPC path sets
  // intent.parentSessionId, so this block won't fire for internal callers.
  if (intent.parentSessionId) {
    registerChildSession(sessionId, {
      parentSessionId: intent.parentSessionId,
      autoClose: !!intent.autoClose,
      visible: !!intent.visible,
    });

    if (rekeyPromise) {
      rekeyPromise.then((realId) => {
        rekeyChildSession(sessionId, realId);
      }).catch((err) => {
        log({ source: 'session', level: 'error', summary: `child rekey failed for ${sessionId.slice(0, 20)}…`, data: { error: String(err) } });
      });
    }
  }

  log({
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

  // Attach before adapter sees the first awaiting_approval event
  if (intent.arbiterPolicy) {
    channel.arbiterPolicy = intent.arbiterPolicy;
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

  // Persist sessionKind after rekey so system sessions stay hidden across restarts
  const targetSessionKind = 'sessionKind' in intent.target ? (intent.target as { sessionKind?: 'user' | 'system' }).sessionKind : undefined;
  if (targetSessionKind && rekeyPromise) {
    rekeyPromise.then((realId) => {
      try { setSessionKind(realId, targetSessionKind); invalidateSessionCache(); } catch { /* best-effort */ }
    }).catch(() => {});
  }

  return { sessionId, channel, rekeyPromise };

  } catch (err) {
    log({
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
  log({ source: 'session', level: 'info', summary: `Session: destroyed ${sessionId.slice(0, 12)}…` });
  destroyChannel(sessionId);
  sessions.delete(sessionId);
  // Mark child session as closed instead of deleting — closed children must
  // remain queryable so callers (e.g. superthink) can read their transcripts.
  const closeMeta = childSessions.get(sessionId);
  if (closeMeta) childSessions.set(sessionId, { ...closeMeta, closed: true });
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
    skipPersistSession = false,
    autoClose = true,
    timeoutMs = 60_000,
  } = options;

  // Get parent's project path for cross-vendor cwd
  const parentInfo = findSession(parentSessionId);
  const cwd = normalizePath(options.cwd ?? parentInfo?.projectPath ?? defaultCwd);

  // Common ephemeral options shared by all target kinds
  const ephemeral: EphemeralTargetOptions = {
    skipPersistSession,
    ...(options.mcpServers && { mcpServers: options.mcpServers }),
    ...(options.plugins && { plugins: options.plugins }),
    ...(options.env && { env: options.env }),
    ...(options.systemPrompt && { systemPrompt: options.systemPrompt }),
    ...(options.sessionKind && { sessionKind: options.sessionKind }),
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
      log({ level: 'warn', source: 'child-session', summary: `No adapter for parent vendor "${parentVendor}" — falling back to blank new session` });
      target = { kind: 'new', vendor: vendor as Vendor, cwd, ...ephemeral };
    }
  } else {
    // forceNew — intentionally blank (no transcript context needed, e.g. tracker/recall)
    target = { kind: 'new', vendor: vendor as Vendor, cwd, ...ephemeral };
  }

  // When an arbiter policy is attached, force permission mode so approval
  // events fire. bypassPermissions / allowDangerouslySkipPermissions would
  // cause the SDK to skip canUseTool() entirely, defeating the arbiter.
  const effectiveSettings = options.arbiterPolicy
    ? { ...settings, permissionMode: 'default' as const, allowDangerouslySkipPermissions: false }
    : settings;

  const intent: TurnIntent = {
    target,
    content: prompt,
    clientMessageId: crypto.randomUUID(),
    settings: effectiveSettings,
    ...(options.openChannel && { openChannel: true }),
    ...(autoClose !== undefined && { autoClose }),
    ...(options.arbiterPolicy && { arbiterPolicy: options.arbiterPolicy }),
  };

  // Allocate a deterministic pending ID up front so cleanup always has a
  // channel reference, even if sendTurn hasn't resolved yet.
  const pendingId = `pending:child-${crypto.randomUUID()}`;

  log({ source: 'session', level: 'info', summary: `Session: dispatching child (${vendor}) for parent ${parentSessionId.slice(0, 12)}…`, data: { parentSessionId, vendor, timeoutMs } });
  log({ level: 'debug', source: 'dispatch', summary: `Channel: creating new pending channel ${pendingId.slice(0, 30)}… (target: ${target.kind}, vendor: ${vendor})` });

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
    // Token accumulators — sum per-entry usage for accurate totals (Claude)
    const tokenAcc: ChildTokenAccumulator = { input: 0, output: 0, cacheRead: 0 };

    // Timeout: safety net for hung adapters / infinite loops.
    // timeoutMs=0 disables the timeout — used for long-running agent sessions
    // that should wait indefinitely for the turn to complete naturally.
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (!settled) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        const parts: string[] = [];
        if (lastError) parts.push(`error: ${lastError}`);
        parts.push(`entries: [${entryTypes.join(', ')}]`);
        if (contentSummaries.length > 0) parts.push(`content: ${contentSummaries.join(', ')}`);
        parts.push(`text: ${text.length} chars`);
        log({ level: 'debug', source: 'dispatch', summary: `Timeout fired: ${timeoutMs}ms elapsed, entries: ${entryTypes.length}, textLen: ${text.length} (parent: ${parentSessionId})` });
        log({ level: 'warn', source: 'child-session', summary: `Timeout after ${timeoutMs}ms — no idle event received (parent: ${parentSessionId}, vendor: ${vendor}) — ${parts.join(' | ')}` });
        settled = true;
        if (text) {
          const contextUsage = buildChildUsage(currentId, tokenAcc);
          cleanup();
          log({ level: 'debug', source: 'dispatch', summary: `Timeout with partial text — returning partial result (${text.length} chars)` });
          log({ level: 'warn', source: 'child-session', summary: `Timeout with partial text (${text.length} chars) -- returning partial result (parent: ${parentSessionId}, vendor: ${vendor})` });
          resolve({ sessionId: currentId, text, structured, contextUsage });
        } else {
          // No text → caller gets null and has no session ID to clean up.
          // Force-close to prevent leaking channel+adapter+MCP subprocesses.
          log({ level: 'debug', source: 'dispatch', summary: `Timeout null result: no text collected, force-closing channel (parent: ${parentSessionId})` });
          cleanup(/* force */ true);
          resolve(null);
        }
      }
    }, timeoutMs) : null;

    // force=true tears down even when autoClose:false — used when the dispatch
    // resolves null (no session ID returned to caller → unreachable channel).
    const cleanup = (force = false) => {
      if (timer) clearTimeout(timer);
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
        // Mark child as closed when shutting down. For autoClose: false (no force),
        // the child stays alive for resumeChildSession — isChildSession() must
        // still recognize it to prevent lifecycle hooks from firing on it.
        if (shouldClose) {
          const cleanupMeta = childSessions.get(id);
          if (cleanupMeta) childSessions.set(id, { ...cleanupMeta, closed: true });
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
          // Streaming content is too noisy — log once when streaming starts
          if (evt.type === 'notification' && (evt as { kind?: string }).kind === 'streaming_content') {
            if (!streamingDots) {
              log({ level: 'debug', source: 'dispatch', summary: `Event: notification/streaming_content started (parent: ${parentSessionId})` });
              streamingDots = true;
            }
          } else {
            if (streamingDots) streamingDots = false;
            log({ level: 'debug', source: 'dispatch', summary: `Event: ${evt.type}${evt.type === 'status' ? `=${(evt as { status?: string }).status}` : evt.type === 'notification' ? `/${(evt as { kind?: string }).kind}` : ''} (parent: ${parentSessionId})` });
          }
        } else if (msg.type === 'entry') {
          if (streamingDots) streamingDots = false;
          const hasText = msg.entry.message?.content ? (Array.isArray(msg.entry.message.content) ? msg.entry.message.content.some((b: { type?: string; text?: string }) => b.type === 'text' && !!b.text) : typeof msg.entry.message.content === 'string' && msg.entry.message.content.length > 0) : false;
          const hasStructured = msg.entry.metadata?.structured_output !== undefined;
          log({ level: 'debug', source: 'dispatch', summary: `Entry: ${msg.entry.type} (parent: ${parentSessionId}, hasText: ${hasText}, hasStructured: ${hasStructured})` });
        }

        // Track error notifications from the adapter (SDK failures, auth errors, etc.)
        if (msg.type === 'event' && msg.event.type === 'notification' && msg.event.kind === 'error') {
          lastError = (msg.event as { error?: string }).error ?? 'unknown error';
          log({ level: 'error', source: 'child-session', summary: `Error notification: ${lastError} (parent: ${parentSessionId})` });
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
          // Accumulate per-entry token usage (Claude sends per-turn usage on assistant entries)
          accumulateEntryUsage(entry, tokenAcc);
        }

        // Stream entries to caller via onEntry callback
        options.onEntry?.(msg);

        // Idle debounce: wait IDLE_SETTLE_MS after idle before resolving.
        // Cancels if 'active' fires (agent starting another tool round).
        // Prevents spurious early resolution in multi-step agent work (fix #8).
        if (msg.type === 'event' && msg.event.type === 'status' && msg.event.status === 'active') {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        }

        // For autoClose:false children, ensure we return the real (rekeyed) ID
        // so resumeChildSession can find the channel. Idle can fire before the
        // rekey promise resolves, leaving currentId as the stale pending ID.
        const finalize = (resolvedId: string) => {
          if (text || structured !== undefined || entryTypes.length > 1) {
            const contextUsage = buildChildUsage(resolvedId, tokenAcc);
            cleanup();
            resolve({ sessionId: resolvedId, text, structured, contextUsage });
          } else {
            const parts: string[] = [];
            if (lastError) parts.push(`error: ${lastError}`);
            parts.push(`entries: [${entryTypes.join(', ')}]`);
            if (contentSummaries.length > 0) parts.push(`content: ${contentSummaries.join(', ')}`);
            log({ source: 'session-manager:dispatch', level: 'warn',
              summary: `Turn completed with empty response (parent: ${parentSessionId}) — ${parts.join(' | ')}` });
            cleanup(/* force */ true);
            resolve(null);
          }
        };

        const awaitRekeyThenFinalize = () => {
          if (!autoClose && rekeyPromise) {
            rekeyPromise.then((realId) => {
              childSessions.delete(pendingId);
              childSessions.set(realId, { parentSessionId, autoClose, visible: !!options.openChannel });
              finalize(realId);
            }).catch(() => finalize(currentId));
          } else {
            finalize(currentId);
          }
        };

        // Turn complete — check for authoritative turnComplete signal
        if (msg.type === 'event' && msg.event.type === 'status' && msg.event.status === 'idle') {
          log({ level: 'debug', source: 'dispatch', summary: `Idle event received (parent: ${parentSessionId}, textSoFar: ${text.length} chars, entries: ${entryTypes.length})` });

          // Authoritative turn completion — resolve immediately, no debounce
          if ('turnComplete' in msg.event && msg.event.turnComplete) {
            if (settled) return;
            settled = true;
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            awaitRekeyThenFinalize();
            return;
          }

          // Fallback: debounced idle for adapters without turnComplete
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            awaitRekeyThenFinalize();
          }, IDLE_SETTLE_MS);
        }
      },
    };

    // Register the pending ID as a child session before sendTurn so cleanup
    // always has something to work with.
    childSessions.set(pendingId, { parentSessionId, autoClose, visible: !!options.openChannel });

    // Fire the turn with the explicit pending ID
    const promptLen = typeof prompt === 'string' ? prompt.length : Array.isArray(prompt) ? prompt.reduce((n, b) => n + ((b as { text?: string }).text?.length ?? 0), 0) : 0;
    log({ level: 'debug', source: 'dispatch', summary: `sendTurn entry (parent: ${parentSessionId}, vendor: ${vendor}, pending: ${pendingId.slice(0, 30)}…, promptLen: ${promptLen})` });
    sendTurn(intent, internalSubscriber, pendingId)
      .then((result) => {
        if (settled) return;
        log({ level: 'debug', source: 'dispatch', summary: `sendTurn resolved — sessionId: ${result.sessionId} (parent: ${parentSessionId})` });
        currentId = result.sessionId;
        // Migrate child tracking from pending to real ID
        childSessions.delete(pendingId);
        childSessions.set(currentId, { parentSessionId, autoClose, visible: !!options.openChannel });

        // Handle pending->real ID re-keying
        if (result.rekeyPromise) {
          rekeyPromise = result.rekeyPromise;
          result.rekeyPromise.then((realId) => {
            if (settled) return;
            childSessions.delete(currentId);
            childSessions.set(realId, { parentSessionId, autoClose, visible: !!options.openChannel });
            currentId = realId;
            // Persist session kind so system sessions stay hidden across restarts
            if (options.sessionKind) {
              try { setSessionKind(realId, options.sessionKind); invalidateSessionCache(); } catch { /* best-effort */ }
            }
          }).catch(() => {});
        }
      })
      .catch((err) => {
        if (!settled) {
          log({ level: 'warn', source: 'child-session', summary: `sendTurn failed (parent: ${parentSessionId}, vendor: ${vendor}): ${err instanceof Error ? err.message : String(err)}` });
          log({ source: 'session', level: 'error', summary: `Session: child dispatch failed (${vendor})`, data: { parentSessionId, vendor, error: err instanceof Error ? err.message : String(err) } });
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
  /** Called for each channel message — use for streaming log output. */
  onEntry?: (msg: ChannelMessage) => void;
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
    onEntry,
  } = options;

  const ch = getChannel(sessionId);
  if (!ch) {
    log({ level: 'debug', source: 'dispatch', summary: `Resume: no channel found for ${sessionId} — null result (channel not open or already closed)` });
    log({ level: 'warn', source: 'resume-child', summary: `No channel found for session ${sessionId}` });
    return null;
  }
  log({ level: 'debug', source: 'dispatch', summary: `Resume: reusing existing channel for ${sessionId.slice(0, 12)}…` });

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

  log({ source: 'session', level: 'info', summary: `Session: resuming child ${sessionId.slice(0, 12)}…`, data: { sessionId, timeoutMs } });

  // Snapshot baseline cost before sending turn — for resumed sessions the
  // adapter tracks cumulative cost, so we need the delta.
  const baselineCostUsd = getChannel(sessionId)?.adapter?.contextUsage?.totalCostUsd;

  return new Promise<ChildSessionResult | null>((resolve) => {
    let text = '';
    let structured: unknown;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    // Token accumulators — sum per-entry usage for accurate totals (Claude)
    const tokenAcc: ChildTokenAccumulator = { input: 0, output: 0, cacheRead: 0 };

    // Timeout: safety net for hung adapters / infinite loops.
    // timeoutMs=0 disables the timeout — used for long-running agent sessions
    // that should wait indefinitely for the turn to complete naturally.
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (!settled) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        const parts: string[] = [];
        if (lastError) parts.push(`error: ${lastError}`);
        parts.push(`entries: [${entryTypes.join(', ')}]`);
        parts.push(`text: ${text.length} chars`);
        log({ level: 'debug', source: 'dispatch', summary: `Resume timeout fired: ${timeoutMs}ms elapsed, entries: ${entryTypes.length}, textLen: ${text.length} (session: ${sessionId.slice(0, 12)}…)` });
        log({ level: 'warn', source: 'resume-child', summary: `Timeout after ${timeoutMs}ms — session ${sessionId} — ${parts.join(' | ')}` });
        settled = true;
        const contextUsage = buildChildUsage(sessionId, tokenAcc, baselineCostUsd);
        cleanup();
        if (text) {
          log({ level: 'debug', source: 'dispatch', summary: `Resume timeout with partial text — returning partial result (${text.length} chars)` });
          resolve({ sessionId, text, structured, contextUsage });
        } else {
          log({ level: 'debug', source: 'dispatch', summary: `Resume timeout null result: no text collected (session: ${sessionId.slice(0, 12)}…)` });
          resolve(null);
        }
      }
    }, timeoutMs) : null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const ch = getChannel(sessionId);
      if (ch) {
        unsubscribe(ch, internalSubscriber);
        if (autoClose) {
          closeSession(sessionId);
        }
      }
      if (autoClose) {
        const closedMeta = childSessions.get(sessionId);
        if (closedMeta) childSessions.set(sessionId, { ...closedMeta, closed: true });
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
          log({ level: 'error', source: 'resume-child', summary: `Error notification: ${lastError} (session: ${sessionId})` });
        }

        // Collect response text and structured output
        if (msg.type === 'entry') {
          const entry = msg.entry;
          entryTypes.push(entry.type);
          const hasText = entry.message?.content ? (Array.isArray(entry.message.content) ? entry.message.content.some((b: { type?: string; text?: string }) => b.type === 'text' && !!b.text) : typeof entry.message.content === 'string' && entry.message.content.length > 0) : false;
          const hasStructured = entry.metadata?.structured_output !== undefined;
          log({ level: 'debug', source: 'dispatch', summary: `Resume entry: ${entry.type} (session: ${sessionId.slice(0, 12)}…, hasText: ${hasText}, hasStructured: ${hasStructured})` });
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
          if (hasStructured) {
            structured = entry.metadata!.structured_output;
          }
          // Accumulate per-entry token usage (Claude sends per-turn usage on assistant entries)
          accumulateEntryUsage(entry, tokenAcc);
        }

        // Stream entries to caller via onEntry callback
        onEntry?.(msg);

        // Idle debounce (fix #8)
        if (msg.type === 'event' && msg.event.type === 'status' && msg.event.status === 'active') {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        }

        const finalizeResume = () => {
          const contextUsage = buildChildUsage(sessionId, tokenAcc, baselineCostUsd);
          cleanup();
          if (text || structured !== undefined || entryTypes.length > 1) {
            resolve({ sessionId, text, structured, contextUsage });
          } else {
            if (lastError) log({ source: 'session-manager:resume', level: 'warn',
              summary: `Empty response with error: ${lastError}` });
            resolve(null);
          }
        };

        // Turn complete — check for authoritative turnComplete signal
        if (msg.type === 'event' && msg.event.type === 'status' && msg.event.status === 'idle') {
          log({ level: 'debug', source: 'dispatch', summary: `Resume idle event (session: ${sessionId.slice(0, 12)}…, textSoFar: ${text.length} chars, entries: ${entryTypes.length})` });

          // Authoritative turn completion — resolve immediately, no debounce
          if ('turnComplete' in msg.event && msg.event.turnComplete) {
            if (settled) return;
            settled = true;
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            finalizeResume();
            return;
          }

          // Fallback: debounced idle for adapters without turnComplete
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            finalizeResume();
          }, IDLE_SETTLE_MS);
        }
      },
    };

    // Subscribe to the existing channel
    subscribe(ch, internalSubscriber);

    // Send the turn — no pending ID needed, session already exists
    const resumePromptLen = typeof prompt === 'string' ? prompt.length : Array.isArray(prompt) ? prompt.reduce((n, b) => n + ((b as { text?: string }).text?.length ?? 0), 0) : 0;
    log({ level: 'debug', source: 'dispatch', summary: `Resume sendTurn entry (session: ${sessionId.slice(0, 12)}…, promptLen: ${resumePromptLen})` });
    sendTurn(intent, internalSubscriber)
      .then(() => {
        if (settled) return;
        log({ level: 'debug', source: 'dispatch', summary: `Resume sendTurn resolved for ${sessionId.slice(0, 12)}…` });
      })
      .catch((err) => {
        if (!settled) {
          log({ level: 'warn', source: 'resume-child', summary: `sendTurn failed: ${err instanceof Error ? err.message : String(err)}` });
          log({ source: 'session', level: 'error', summary: `Session: child resume failed`, data: { sessionId, error: err instanceof Error ? err.message : String(err) } });
          settled = true;
          cleanup();
          resolve(null);
        }
      });
  });
}
