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
 * - Approval flow is simpler than Leto: pendingApprovals is a Set<string>
 *   (toolUseIds only), not a Map with resolve/reject. The adapter handles
 *   resolution internally via respondToApproval().
 * - State transitions are adapter-driven: after resolveApproval(), the
 *   channel waits for the adapter's 'active' status event rather than
 *   manually transitioning to streaming.
 * - No replaceAdapter — to switch adapters, destroyChannel + createChannel.
 *
 * @module session-channel
 */

import type { AgentAdapter, ChannelMessage, SendOptions } from './agent-adapter.js';
import type { MessageContent, Vendor, TranscriptEntry } from './transcript.js';
import type {
  ChannelEvent,
  StatusEvent,
  NotificationEvent,
  ApprovalOption,
} from './channel-events.js';

// ============================================================================
// Subscriber Event — discriminated union pushed to all subscribers
// ============================================================================

/**
 * All events a session channel can emit. Subscribers receive these via a
 * single `send(event)` method — easy to serialize over any transport.
 *
 * Adapted from Leto's ChannelEvent. Key differences:
 * - approval_request/approval_resolved replace interaction_request/interaction_resolved
 * - notification wraps adapter notification events directly
 */
export type SubscriberEvent =
  | { type: 'entry'; entry: TranscriptEntry; index: number }
  | { type: 'history'; entries: TranscriptEntry[] }
  | { type: 'state_changed'; state: SessionChannelState; snapshot: ChannelSnapshot }
  | { type: 'approval_request'; toolUseId: string; toolName: string; input: unknown; reason?: string; options: ApprovalOption[] }
  | { type: 'approval_resolved'; toolUseId: string }
  | { type: 'notification'; event: NotificationEvent }
  | { type: 'error'; error: string };

// ============================================================================
// Subscriber — anything that wants to receive channel events
// ============================================================================

/**
 * A subscriber receives channel events via a single send() method.
 * Could be a VS Code webview panel, an SSE connection, a test harness, etc.
 *
 * The single-method interface makes it trivially adaptable:
 *   - Webview: `{ id, send: (e) => panel.webview.postMessage(e) }`
 *   - SSE:    `{ id, send: (e) => res.write(\`data: ${JSON.stringify(e)}\\n\\n\`) }`
 *   - Test:   `{ id, send: (e) => collected.push(e) }`
 */
export interface Subscriber {
  readonly id: string;
  send(event: SubscriberEvent): void;
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
export type SessionChannelState = 'unattached' | 'idle' | 'streaming' | 'awaiting_approval';

// ============================================================================
// Snapshot
// ============================================================================

/** Snapshot of channel state pushed to subscribers via state_changed events. */
export interface ChannelSnapshot {
  state: SessionChannelState;
  sessionId: string | undefined;
  vendor: Vendor | undefined;
}

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

  /** Pending approval toolUseIds — tracking only, no resolve/reject. */
  pendingApprovals: Set<string>;

  /** Running count of entries broadcast (used as index in entry events). */
  entryIndex: number;

  /** Resolves when the consumption loop exits. */
  loopDone: Promise<void> | null;

  /** Guards against race conditions during teardown. */
  tearing: boolean;
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
    pendingApprovals: new Set(),
    entryIndex: 0,
    loopDone: null,
    tearing: false,
  };

  channels.set(channelId, channel);
  return channel;
}

/** Get a channel by ID. */
export function getChannel(channelId: string): SessionChannel | undefined {
  return channels.get(channelId);
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
 */
export function subscribe(channel: SessionChannel, subscriber: Subscriber): void {
  channel.subscribers.set(subscriber.id, subscriber);
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

function broadcast(channel: SessionChannel, event: SubscriberEvent): void {
  for (const [, subscriber] of channel.subscribers) {
    try {
      subscriber.send(event);
    } catch {
      // Bad subscriber — swallow error, don't crash the channel
    }
  }
}

/** Build a snapshot of the current channel state. */
function getSnapshot(channel: SessionChannel): ChannelSnapshot {
  return {
    state: channel.state,
    sessionId: channel.adapter?.sessionId,
    vendor: channel.adapter?.vendor,
  };
}

/** Transition state and notify subscribers of the change. */
function setState(channel: SessionChannel, state: SessionChannelState): void {
  channel.state = state;
  broadcast(channel, {
    type: 'state_changed',
    state,
    snapshot: getSnapshot(channel),
  });
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
 */
export function setAdapter(channel: SessionChannel, adapter: AgentAdapter): void {
  if (channel.adapter) {
    throw new Error('Adapter already set. Destroy and recreate the channel to switch adapters.');
  }

  channel.adapter = adapter;
  channel.entryIndex = 0;
  setState(channel, 'idle');
  startConsumptionLoop(channel);
}

// ============================================================================
// Consumption Loop
// ============================================================================

/**
 * Fire-and-forget async loop that drains the adapter's message stream
 * and routes each message to subscribers.
 *
 * Critical adapter behavior that drives this design:
 * - close() emits idle status, then done() → stream terminates → loop exits → unattached
 * - drainOutput() finally block: emits idle but does NOT done() → stream stays open → idle
 * - drainOutput() catch block: emits error notification → loop routes it → broadcast
 */
function startConsumptionLoop(channel: SessionChannel): void {
  const adapter = channel.adapter!;

  channel.loopDone = (async () => {
    try {
      for await (const msg of adapter.messages()) {
        if (channel.tearing) break;
        routeMessage(channel, msg);
      }
      // Stream exhausted — adapter was close()d
      if (!channel.tearing) {
        channel.pendingApprovals.clear();
        setState(channel, 'unattached');
      }
    } catch (err) {
      if (!channel.tearing) {
        broadcast(channel, {
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        channel.pendingApprovals.clear();
        // Stream error kills the loop permanently — unattached, not idle.
        // To recover, destroy and recreate the channel with a fresh adapter.
        setState(channel, 'unattached');
      }
    }
  })();
}

// ============================================================================
// Message Routing
// ============================================================================

/**
 * Route a ChannelMessage from the adapter to the appropriate subscriber event(s).
 *
 * Entry messages are broadcast directly with an incrementing index.
 * Event messages are discriminated on their event type (status vs notification).
 */
function routeMessage(channel: SessionChannel, msg: ChannelMessage): void {
  if (msg.type === 'entry') {
    broadcast(channel, {
      type: 'entry',
      entry: msg.entry,
      index: channel.entryIndex++,
    });
    return;
  }

  // msg.type === 'event'
  const event: ChannelEvent = msg.event;

  if (event.type === 'status') {
    routeStatusEvent(channel, event);
  } else {
    // event.type === 'notification'
    routeNotificationEvent(channel, event);
  }
}

/**
 * Route status events to state transitions.
 */
function routeStatusEvent(
  channel: SessionChannel,
  event: StatusEvent,
): void {
  switch (event.status) {
    case 'active':
      setState(channel, 'streaming');
      break;

    case 'idle':
      channel.pendingApprovals.clear();
      setState(channel, 'idle');
      break;

    case 'awaiting_approval': {
      // TS narrows to AwaitingApprovalEvent via the switch on event.status
      const { toolUseId, toolName, input, reason, options } = event;
      channel.pendingApprovals.add(toolUseId);
      setState(channel, 'awaiting_approval');
      broadcast(channel, {
        type: 'approval_request',
        toolUseId,
        toolName,
        input,
        reason,
        options,
      });
      break;
    }
  }
}

/**
 * Route notification events to subscriber events.
 */
function routeNotificationEvent(
  channel: SessionChannel,
  event: NotificationEvent,
): void {
  if (event.kind === 'error') {
    const errorMsg = event.error instanceof Error ? event.error.message : String(event.error);
    broadcast(channel, { type: 'error', error: errorMsg });
  } else {
    // session_changed, compacting, permission_mode_changed → pass through
    broadcast(channel, { type: 'notification', event });
  }
}

// ============================================================================
// User Actions
// ============================================================================

/**
 * Send a user message into the channel.
 *
 * Guards: throws if no adapter. The adapter handles lazy query start,
 * closed checks, and awaiting_approval guards internally.
 *
 * Options (model, permissionMode, etc.) are threaded through to the
 * adapter so they can be applied atomically at query start time.
 */
export function sendMessage(channel: SessionChannel, message: MessageContent, options?: SendOptions): void {
  if (!channel.adapter) {
    throw new Error('No adapter set. Call setAdapter() first.');
  }
  channel.adapter.send(message, options);
}

/**
 * Respond to a pending approval request.
 *
 * - Delegates to adapter.respondToApproval() — adapter validates optionId
 * - Removes toolUseId from pendingApprovals set
 * - Broadcasts approval_resolved
 * - Does NOT setState — the adapter will emit an active status event
 *   when all approvals are resolved, which flows through the consumption
 *   loop to routeMessage → setState('streaming')
 */
export function resolveApproval(
  channel: SessionChannel,
  toolUseId: string,
  optionId: string,
): void {
  if (!channel.adapter) {
    throw new Error('No adapter set. Call setAdapter() first.');
  }

  if (!channel.pendingApprovals.has(toolUseId)) {
    console.warn(`[session-channel] No pending approval for toolUseId "${toolUseId}"`);
    return;
  }

  // Let adapter throw on invalid optionId — don't clean up pendingApprovals
  // so the caller can retry with a valid option.
  channel.adapter.respondToApproval(toolUseId, optionId);
  channel.pendingApprovals.delete(toolUseId);
  broadcast(channel, { type: 'approval_resolved', toolUseId });
}

/**
 * Backfill historical transcript entries and broadcast them as a batch.
 * Subscribers receive a single { type: "history" } event with all entries,
 * rather than N individual entry events — avoids render thrashing.
 *
 * Stateless — does not change channel state. Accepts pre-loaded entries
 * so the caller (session-manager) handles discovery/loading.
 */
export function backfillHistory(
  channel: SessionChannel,
  entries: TranscriptEntry[],
): void {
  if (entries.length === 0) return;

  broadcast(channel, { type: 'history', entries });
  channel.entryIndex = entries.length;
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
 * - Broadcasts state_changed to unattached
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
  setState(channel, 'unattached');

  // Note: tearing stays true. Once torn down, the channel is terminal.
  // This prevents the async consumption loop from emitting duplicate
  // state_changed events when it wakes up and sees the stream is done.
}
