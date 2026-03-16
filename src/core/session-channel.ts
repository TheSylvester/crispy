/**
 * Session Channel — Multiplexed Agent Session Management
 *
 * The fan-out multiplexer between one AgentAdapter (the vendor connection)
 * and N subscribers (webview panels, SSE connections, test harnesses).
 *
 * Architecture:
 *   SessionChannel ──owns──▶ AgentAdapter (vendor connection)
 *        │
 *        ├── Subscriber (VS Code webview panel)
 *        ├── Subscriber (SSE connection)
 *        └── Subscriber (test harness)
 *
 * Key design decisions:
 * - Functional API (createChannel, setAdapter, etc.) — not a class
 * - Discriminated union events — single send() method per subscriber
 * - pendingApprovals is a Map<string,
 *   PendingApprovalInfo> (keyed by toolUseId), not a Map with resolve/reject.
 *   The adapter handles resolution internally via respondToApproval().
 *   Full approval data is stored so late subscribers can receive pending
 *   approval_request events on subscribe().
 * - State transitions are adapter-driven: after resolveApproval(), the
 *   channel waits for the adapter's 'active' status event rather than
 *   manually transitioning to streaming.
 * - No replaceAdapter — to switch adapters, destroyChannel + createChannel.
 *
 * @module session-channel
 */

import type { AgentAdapter, ChannelMessage } from './agent-adapter.js';
import { pushRosieLog } from './rosie/index.js';
import type { TranscriptEntry } from './transcript.js';
import type {
  ChannelCatchupMessage,
  PendingApprovalInfo,
} from './channel-events.js';

// Re-export for backwards compatibility
export type { PendingApprovalInfo } from './channel-events.js';

/**
 * Union of all message types a subscriber can receive:
 * - ChannelMessage: entry or event from the adapter
 * - ChannelCatchupMessage: state sync for late subscribers (includes history entries)
 */
export type SubscriberMessage = ChannelMessage | ChannelCatchupMessage;

// ============================================================================
// Subscriber — anything that wants to receive channel events
// ============================================================================

/**
 * A subscriber receives channel messages via a single send() method.
 * Could be a VS Code webview panel, an SSE connection, a test harness, etc.
 *
 * The channel is a "dumb fan-out pipe" — it broadcasts raw ChannelMessage
 * from the adapter, plus ChannelCatchupMessage for late subscriber sync
 * (which includes history entries).
 *
 * The single-method interface makes it trivially adaptable:
 *   - Webview: `{ id, send: (e) => panel.webview.postMessage(e) }`
 *   - SSE:    `{ id, send: (e) => res.write(\`data: ${JSON.stringify(e)}\\n\\n\`) }`
 *   - Test:   `{ id, send: (e) => collected.push(e) }`
 */
export interface Subscriber {
  readonly id: string;
  send(event: ChannelMessage | ChannelCatchupMessage): void;
}

// ============================================================================
// State Machine
// ============================================================================

/**
 * Four-state machine:
 *
 *   unattached ──setAdapter──▶ idle ──(adapter emits active)──▶ streaming
 *       ▲                       ▲        ◀──(adapter emits idle)──┘  │
 *       │                       │                                     │
 *       │                       │   (adapter emits awaiting_approval)  │
 *       │                       │                                     ▼
 *       │                       └──(adapter emits active)─── awaiting_approval
 *       │
 *       └────── (stream exhausted / adapter closed) ──────────────────┘
 *
 * - unattached: No adapter installed, or adapter's stream loop is terminal
 *               (stream exhausted or errored). Requires destroy+recreate to recover.
 * - idle:       Adapter installed and stream open, query finished naturally
 *               (adapter emitted idle). Ready for next send().
 * - streaming:  Actively consuming messages (adapter status is active).
 * - awaiting_approval: One or more pending approval requests from the adapter.
 */
export type SessionChannelState = 'unattached' | 'idle' | 'streaming' | 'awaiting_approval' | 'background';


// ============================================================================
// Session Channel
// ============================================================================

/** The session channel state bag — functions operate on this. */
export interface SessionChannel {
  /** Channel identifier (e.g., workspace ID, tab ID). */
  readonly channelId: string;

  /** The vendor adapter — single writer, owned by this channel. */
  adapter: AgentAdapter | null;

  /** All subscribers — N readers. */
  subscribers: Map<string, Subscriber>;

  /** Current state machine position. */
  state: SessionChannelState;

  /** Pending approval data — tracking + replay for late subscribers. */
  pendingApprovals: Map<string, PendingApprovalInfo>;

  /** Running count of entries broadcast (used as index in entry events). */
  entryIndex: number;

  /** Resolves when the consumption loop exits. */
  loopDone: Promise<void> | null;

  /** Guards against race conditions during teardown. */
  tearing: boolean;

  /** Optional callback invoked when the channel transitions to idle (end of turn). */
  onIdle?: () => void;

  /** Optional callback invoked on any status state change (active/idle/approval/background). */
  onStatusChange?: (state: SessionChannelState) => void;
}

// ============================================================================
// Channel Registry
// ============================================================================

const channels = new Map<string, SessionChannel>();

/**
 * Create a new session channel in the 'unattached' state.
 * Throws if a channel with the same ID already exists.
 */
export function createChannel(channelId: string): SessionChannel {
  if (channels.has(channelId)) {
    throw new Error(`Channel "${channelId}" already exists`);
  }

  const channel: SessionChannel = {
    channelId,
    adapter: null,
    subscribers: new Map(),
    state: 'unattached',
    pendingApprovals: new Map(),
    entryIndex: 0,
    loopDone: null,
    tearing: false,
  };

  channels.set(channelId, channel);
  return channel;
}

/**
 * Get a channel by ID.
 *
 * @internal Test and diagnostic scripts only. Production code should use the
 * channel returned by session-manager functions (subscribeSession, sendTurn,
 * etc.) rather than looking it up by ID.
 */
export function getChannel(channelId: string): SessionChannel | undefined {
  return channels.get(channelId);
}

/**
 * Get all active channels (those with a bound adapter).
 *
 * Used by adapter-registry to propagate live configuration changes
 * (e.g., MCP server toggle) to active sessions.
 */
export function getActiveChannels(): SessionChannel[] {
  return [...channels.values()].filter((ch) => ch.adapter != null);
}

/** Destroy a channel — tears down adapter, removes from registry. */
export function destroyChannel(channelId: string): void {
  const channel = channels.get(channelId);
  if (!channel) return;

  teardown(channel);
  channels.delete(channelId);
}

/**
 * Re-key a channel from oldId to newId in the internal registry.
 * Used when a fresh session's pending ID is replaced by the real session ID.
 */
export function rekeyChannel(oldId: string, newId: string): void {
  const channel = channels.get(oldId);
  if (!channel) throw new Error(`Cannot re-key: no channel with ID "${oldId}"`);
  if (channels.has(newId)) throw new Error(`Cannot re-key: channel "${newId}" already exists`);
  channels.delete(oldId);
  channels.set(newId, channel);
}

/** Clear the channel registry (test helper). */
export function _resetRegistry(): void {
  // Teardown all channels first
  for (const channel of channels.values()) {
    teardown(channel);
  }
  channels.clear();
}

// ============================================================================
// Subscribe / Unsubscribe
// ============================================================================

/**
 * Add a subscriber to the channel. Idempotent — replaces existing
 * subscriber with the same ID.
 *
 * Late subscribers immediately receive a catchup message with current
 * channel state (including pending approvals and optional history entries),
 * so their UI matches the session's actual state without waiting for the
 * next event.
 *
 * @param entries Optional history entries to include in the catchup message.
 *                When provided, the channel's entryIndex is set to entries.length.
 */
export function subscribe(
  channel: SessionChannel,
  subscriber: Subscriber,
  entries?: TranscriptEntry[],
): void {
  channel.subscribers.set(subscriber.id, subscriber);

  // Set entry index if history provided (only advance, never go backward)
  if (entries?.length && entries.length > channel.entryIndex) {
    channel.entryIndex = entries.length;
  }

  // Emit catchup with current state (skip 'unattached' — no useful state)
  if (channel.state !== 'unattached') {
    try {
      const catchup: ChannelCatchupMessage = {
        type: 'catchup',
        state: channel.state === 'streaming' ? 'streaming' : channel.state,
        sessionId: channel.adapter?.sessionId,
        settings: channel.adapter?.settings ?? null,
        contextUsage: channel.adapter?.contextUsage ?? null,
        pendingApprovals: Array.from(channel.pendingApprovals.values()),
        entries: entries ?? [],
      };
      subscriber.send(catchup);
    } catch { /* swallow — consistent with broadcast() */ }
  }
}

/**
 * Remove a subscriber by reference or ID.
 */
export function unsubscribe(channel: SessionChannel, subscriberOrId: Subscriber | string): void {
  const id = typeof subscriberOrId === 'string' ? subscriberOrId : subscriberOrId.id;
  channel.subscribers.delete(id);
}

// ============================================================================
// Broadcast — single entry point, try-catch per subscriber
// ============================================================================

function broadcast(channel: SessionChannel, event: ChannelMessage): void {
  for (const [, subscriber] of channel.subscribers) {
    try {
      subscriber.send(event);
    } catch {
      // Bad subscriber — swallow error, don't crash the channel
    }
  }
}

// ============================================================================
// Adapter Management
// ============================================================================

/**
 * Install an adapter on the channel.
 *
 * - Throws if an adapter is already set
 * - Transitions to 'idle' (adapter starts idle before first send())
 * - Starts the consumption loop
 *
 * Note: We just set state to 'idle' without broadcasting — the adapter
 * will emit status events that flow through the consumption loop.
 */
export function setAdapter(channel: SessionChannel, adapter: AgentAdapter): void {
  if (channel.adapter) {
    throw new Error('Adapter already set. Destroy and recreate the channel to switch adapters.');
  }

  channel.adapter = adapter;
  channel.entryIndex = 0;
  channel.state = 'idle'; // Just set, don't broadcast
  startConsumptionLoop(channel);
}

// ============================================================================
// Consumption Loop
// ============================================================================

/**
 * Broadcast a ChannelMessage to all subscribers and track internal state.
 *
 * Internal state tracking is for:
 * 1. Channel state gating (e.g., can't send while awaiting_approval)
 * 2. Pending approvals (for late subscriber catchup)
 * 3. onIdle callback
 */
function broadcastAndTrack(channel: SessionChannel, msg: ChannelMessage): void {
  // Update internal state for gating
  if (msg.type === 'event') {
    const event = msg.event;
    if (event.type === 'status') {
      switch (event.status) {
        case 'active':
          channel.state = 'streaming';
          break;
        case 'idle':
          channel.pendingApprovals.clear();
          channel.state = 'idle';
          channel.onIdle?.();
          break;
        case 'awaiting_approval': {
          const { toolUseId, toolName, input, reason, options } = event;
          channel.pendingApprovals.set(toolUseId, { toolUseId, toolName, input, reason, options });
          channel.state = 'awaiting_approval';
          break;
        }
        case 'background':
          channel.pendingApprovals.clear();
          channel.state = 'background';
          // Do NOT fire onIdle — background tasks are still running
          break;
      }
      // Notify external observers of the status transition
      channel.onStatusChange?.(channel.state);
    }
    // notification events: no internal state change needed (just pass through)
  }

  // Broadcast to all subscribers
  broadcast(channel, msg);

  // Track entry index
  if (msg.type === 'entry') {
    channel.entryIndex++;
  }
}

/**
 * Fire-and-forget async loop that drains the adapter's message stream
 * and broadcasts each message to subscribers.
 *
 * Critical adapter behavior that drives this design:
 * - close() emits idle status, then done() → stream terminates → loop exits → unattached
 * - drainOutput() finally block: emits idle but does NOT done() → stream stays open → idle
 * - drainOutput() catch block: emits error notification → loop broadcasts it
 */
function startConsumptionLoop(channel: SessionChannel): void {
  const adapter = channel.adapter!;

  channel.loopDone = (async () => {
    try {
      for await (const msg of adapter.messages()) {
        if (channel.tearing) break;
        broadcastAndTrack(channel, msg);
      }
      // Stream exhausted — adapter was close()d
      if (!channel.tearing) {
        channel.pendingApprovals.clear();
        channel.state = 'unattached';
        // No broadcast — the adapter should have emitted an idle event before closing
      }
    } catch (err) {
      if (!channel.tearing) {
        // Broadcast error as an event message
        const errorMsg = err instanceof Error ? err.message : String(err);
        broadcast(channel, {
          type: 'event',
          event: { type: 'notification', kind: 'error', error: errorMsg },
        });
        channel.pendingApprovals.clear();
        channel.state = 'unattached';
      }
    }
  })();
}

// ============================================================================
// User Actions
// ============================================================================

/**
 * Respond to a pending approval request.
 *
 * - Delegates to adapter.respondToApproval() — adapter validates optionId
 * - Removes toolUseId from pendingApprovals set
 * - Does NOT broadcast — the adapter will emit status events when it resumes
 */
export function resolveApproval(
  channel: SessionChannel,
  toolUseId: string,
  optionId: string,
  extra?: { message?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] },
): void {
  if (!channel.adapter) {
    throw new Error('No adapter set. Call setAdapter() first.');
  }

  if (!channel.pendingApprovals.has(toolUseId)) {
    pushRosieLog({ level: 'warn', source: 'session-channel', summary: `No pending approval for toolUseId "${toolUseId}"` });
    return;
  }

  // Let adapter throw on invalid optionId — don't clean up pendingApprovals
  // so the caller can retry with a valid option.
  channel.adapter.respondToApproval(toolUseId, optionId, extra);
  channel.pendingApprovals.delete(toolUseId);
  // No broadcast — the adapter will emit status events when it resumes
}

/**
 * Broadcast a user entry to all subscribers.
 *
 * Called by session-manager before sending to the adapter so subscribers
 * see the user message immediately (optimistic rendering). The adapter
 * should suppress re-emission when the SDK echoes the user message back.
 */
export function broadcastUserEntry(
  channel: SessionChannel,
  entry: TranscriptEntry,
): void {
  const msg: ChannelMessage = { type: 'entry', entry };
  broadcastAndTrack(channel, msg);
}

// ============================================================================
// Teardown
// ============================================================================

/**
 * Tear down the channel — close the adapter and reset state.
 *
 * - Sets tearing flag to prevent race conditions in the async loop
 * - Calls adapter.close() (emits idle + done → stream terminates → loop exits)
 * - Clears pendingApprovals
 * - Sets state to unattached (no broadcast — channel is torn down)
 * - tearing stays true (channel is terminal — prevents async loop double-emit)
 */
function teardown(channel: SessionChannel): void {
  if (channel.tearing) return;
  channel.tearing = true;

  if (channel.adapter) {
    // close() is synchronous on AsyncIterableQueue-backed adapters:
    // calls queue.done() which immediately resolves any pending next(),
    // so the consumption loop sees `tearing === true` and exits cleanly.
    channel.adapter.close();
  }

  channel.pendingApprovals.clear();
  channel.state = 'unattached';
  // No broadcast — channel is torn down

  // Note: tearing stays true. Once torn down, the channel is terminal.
  // This prevents the async consumption loop from emitting duplicate
  // events when it wakes up and sees the stream is done.
}
