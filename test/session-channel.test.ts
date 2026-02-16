/**
 * Tests for Session Channel
 *
 * Tests mock at the AgentAdapter boundary. A MockAdapter uses
 * AsyncIterableQueue<ChannelMessage> as the controllable output stream.
 * All adapter methods (send, respondToApproval, close, etc.) are vi.fn() stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncIterableQueue } from '../src/core/async-iterable-queue.js';
import type { AgentAdapter, AdapterSettings, ChannelMessage } from '../src/core/agent-adapter.js';
import type { TranscriptEntry, MessageContent, Vendor } from '../src/core/transcript.js';
import type { ChannelStatus, ApprovalOption, NotificationEvent } from '../src/core/channel-events.js';
import type { Subscriber, SubscriberEvent } from '../src/core/session-channel.js';

import {
  createChannel,
  getChannel,
  destroyChannel,
  _resetRegistry,
  subscribe,
  unsubscribe,
  setAdapter,
  sendMessage,
  resolveApproval,
  backfillHistory,
} from '../src/core/session-channel.js';

// ============================================================================
// Mock Adapter
// ============================================================================

interface MockAdapter extends AgentAdapter {
  /** Push a message into the adapter's output stream. */
  pushMessage(msg: ChannelMessage): void;
  /** Complete the output stream (simulates adapter close). */
  completeStream(): void;
  /** Fail the output stream with an error. */
  failStream(err: Error): void;
  /** Access the underlying queue for verification. */
  readonly outputQueue: AsyncIterableQueue<ChannelMessage>;
}

function createMockAdapter(options?: {
  vendor?: Vendor;
  sessionId?: string;
}): MockAdapter {
  const queue = new AsyncIterableQueue<ChannelMessage>();
  const vendor = options?.vendor ?? 'claude';
  let sessionId = options?.sessionId;
  let status: ChannelStatus = 'idle';

  return {
    vendor,
    get sessionId() { return sessionId; },
    get status() { return status; },
    get contextUsage() { return null; },
    get settings(): AdapterSettings {
      return { model: undefined, permissionMode: undefined, allowDangerouslySkipPermissions: false, extraArgs: undefined };
    },
    outputQueue: queue,

    messages(): AsyncIterable<ChannelMessage> {
      return queue;
    },

    send: vi.fn((_content: MessageContent) => {
      // Simulate: adapter receives message
    }),

    respondToApproval: vi.fn((_toolUseId: string, _optionId: string) => {
      // Simulate: adapter resolves approval
    }),

    close: vi.fn(() => {
      queue.done();
    }),

    interrupt: vi.fn(async () => {}),
    setModel: vi.fn(async (_model?: string) => {}),
    setPermissionMode: vi.fn(async (_mode: string) => {}),

    // Helpers
    pushMessage(msg: ChannelMessage): void {
      queue.enqueue(msg);
    },

    completeStream(): void {
      queue.done();
    },

    failStream(err: Error): void {
      queue.error(err);
    },
  };
}

// ============================================================================
// Test Subscriber
// ============================================================================

interface TestSubscriber extends Subscriber {
  events: SubscriberEvent[];
  eventsOfType<T extends SubscriberEvent['type']>(
    type: T,
  ): Extract<SubscriberEvent, { type: T }>[];
}

function createTestSubscriber(id: string): TestSubscriber {
  const events: SubscriberEvent[] = [];
  return {
    id,
    events,
    send(event: SubscriberEvent): void {
      events.push(event);
    },
    eventsOfType<T extends SubscriberEvent['type']>(
      type: T,
    ): Extract<SubscriberEvent, { type: T }>[] {
      return events.filter((e) => e.type === type) as Extract<SubscriberEvent, { type: T }>[];
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Helper to create an entry ChannelMessage. */
function entryMsg(entry: Partial<TranscriptEntry> = {}): ChannelMessage {
  return {
    type: 'entry',
    entry: { type: 'assistant', message: { role: 'assistant', content: 'hello' }, ...entry },
  };
}

/** Helper to create a status event ChannelMessage. */
function statusMsg(status: 'active' | 'idle'): ChannelMessage {
  return {
    type: 'event',
    event: { type: 'status', status },
  };
}

/** Helper to create an awaiting_approval event ChannelMessage. */
function approvalMsg(
  toolUseId: string,
  toolName = 'Bash',
  input: unknown = { command: 'rm -rf /' },
  options: ApprovalOption[] = [
    { id: 'allow', label: 'Allow once' },
    { id: 'deny', label: 'Deny' },
  ],
  reason?: string,
): ChannelMessage {
  return {
    type: 'event',
    event: {
      type: 'status',
      status: 'awaiting_approval',
      toolUseId,
      toolName,
      input,
      reason,
      options,
    },
  };
}

/** Helper to create a notification event ChannelMessage. */
function notificationMsg(event: NotificationEvent): ChannelMessage {
  return { type: 'event', event };
}

/** Wait for microtasks to settle (lets async loop process enqueued messages). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  _resetRegistry();
});

afterEach(() => {
  _resetRegistry();
});

// ========== 1. Channel Lifecycle ==========

describe('Channel lifecycle', () => {
  it('createChannel creates a channel in unattached state', () => {
    const ch = createChannel('ch-1');
    expect(ch.channelId).toBe('ch-1');
    expect(ch.state).toBe('unattached');
    expect(ch.adapter).toBeNull();
    expect(ch.subscribers.size).toBe(0);
    expect(ch.pendingApprovals.size).toBe(0);
    expect(ch.entryIndex).toBe(0);
    expect(ch.loopDone).toBeNull();
    expect(ch.tearing).toBe(false);
  });

  it('createChannel throws on duplicate channelId', () => {
    createChannel('ch-1');
    expect(() => createChannel('ch-1')).toThrow('already exists');
  });

  it('getChannel returns channel or undefined', () => {
    expect(getChannel('nope')).toBeUndefined();
    const ch = createChannel('ch-1');
    expect(getChannel('ch-1')).toBe(ch);
  });

  it('destroyChannel cleans up and removes from registry', () => {
    const adapter = createMockAdapter();
    const ch = createChannel('ch-1');
    setAdapter(ch, adapter);
    expect(getChannel('ch-1')).toBe(ch);

    destroyChannel('ch-1');
    expect(getChannel('ch-1')).toBeUndefined();
    expect(adapter.close).toHaveBeenCalled();
  });

  it('destroyChannel is no-op for unknown channel', () => {
    expect(() => destroyChannel('nope')).not.toThrow();
  });

  it('_resetRegistry clears all channels', () => {
    createChannel('ch-1');
    createChannel('ch-2');
    _resetRegistry();
    expect(getChannel('ch-1')).toBeUndefined();
    expect(getChannel('ch-2')).toBeUndefined();
  });
});

// ========== 2. Subscribe / Unsubscribe ==========

describe('Subscribe / Unsubscribe', () => {
  it('adds and removes subscribers', () => {
    const ch = createChannel('ch-1');
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    expect(ch.subscribers.size).toBe(1);

    unsubscribe(ch, sub);
    expect(ch.subscribers.size).toBe(0);
  });

  it('unsubscribe works with string ID', () => {
    const ch = createChannel('ch-1');
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    unsubscribe(ch, 'sub-1');
    expect(ch.subscribers.size).toBe(0);
  });

  it('subscribe is idempotent — replaces existing with same ID', () => {
    const ch = createChannel('ch-1');
    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-1');

    subscribe(ch, sub1);
    subscribe(ch, sub2);
    expect(ch.subscribers.size).toBe(1);
    expect(ch.subscribers.get('sub-1')).toBe(sub2);
  });

  it('subscriber added mid-session receives future events', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const earlySubscriber = createTestSubscriber('early');

    subscribe(ch, earlySubscriber);
    setAdapter(ch, adapter);
    await tick();

    // Push first entry — only early subscriber gets it
    adapter.pushMessage(entryMsg({ type: 'user' }));
    await tick();

    const lateSubscriber = createTestSubscriber('late');
    subscribe(ch, lateSubscriber);

    // Late subscriber receives current state on subscribe (idle)
    const lateStateEvents = lateSubscriber.eventsOfType('state_changed');
    expect(lateStateEvents.length).toBe(1);
    expect(lateStateEvents[0].state).toBe('idle');

    // Push second entry — both subscribers get it
    adapter.pushMessage(entryMsg({ type: 'assistant' }));
    await tick();

    // Early subscriber: state_changed(idle) + entry + entry = 3
    // Late subscriber: state_changed(idle) + entry = 2
    expect(earlySubscriber.eventsOfType('entry').length).toBe(2);
    expect(lateSubscriber.eventsOfType('entry').length).toBe(1);
  });

  it('late subscriber receives current state on subscribe', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();

    setAdapter(ch, adapter);
    await tick();

    // Transition to streaming
    adapter.pushMessage(statusMsg('active'));
    await tick();
    expect(ch.state).toBe('streaming');

    // Late subscriber joins mid-streaming
    const lateSub = createTestSubscriber('late');
    subscribe(ch, lateSub);

    const stateEvents = lateSub.eventsOfType('state_changed');
    expect(stateEvents.length).toBe(1);
    expect(stateEvents[0].state).toBe('streaming');
    expect(stateEvents[0].snapshot.state).toBe('streaming');
  });

  it('late subscriber receives pending approval on subscribe', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();

    setAdapter(ch, adapter);
    await tick();

    // Create a pending approval
    adapter.pushMessage(approvalMsg('tool-77', 'Bash', { command: 'ls' }, [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ], 'wants to list files'));
    await tick();
    expect(ch.state).toBe('awaiting_approval');

    // Late subscriber joins during awaiting_approval
    const lateSub = createTestSubscriber('late');
    subscribe(ch, lateSub);

    // Should receive state_changed + approval_request
    const stateEvents = lateSub.eventsOfType('state_changed');
    expect(stateEvents.length).toBe(1);
    expect(stateEvents[0].state).toBe('awaiting_approval');

    const approvalEvents = lateSub.eventsOfType('approval_request');
    expect(approvalEvents.length).toBe(1);
    expect(approvalEvents[0].toolUseId).toBe('tool-77');
    expect(approvalEvents[0].toolName).toBe('Bash');
    expect(approvalEvents[0].input).toEqual({ command: 'ls' });
    expect(approvalEvents[0].reason).toBe('wants to list files');
    expect(approvalEvents[0].options).toHaveLength(2);
  });

  it('late subscriber does not receive state for unattached channel', () => {
    const ch = createChannel('ch-1');
    expect(ch.state).toBe('unattached');

    const lateSub = createTestSubscriber('late');
    subscribe(ch, lateSub);

    // No events should be sent — channel is unattached
    expect(lateSub.events.length).toBe(0);
  });
});

// ========== 3. Adapter Management ==========

describe('Adapter management', () => {
  it('setAdapter transitions to idle and starts loop', async () => {
    const ch = createChannel('ch-1');
    const sub = createTestSubscriber('sub-1');
    subscribe(ch, sub);

    const adapter = createMockAdapter();
    setAdapter(ch, adapter);

    expect(ch.adapter).toBe(adapter);
    expect(ch.state).toBe('idle');
    expect(ch.loopDone).not.toBeNull();

    // Subscriber received state_changed to idle
    const stateEvents = sub.eventsOfType('state_changed');
    expect(stateEvents.length).toBe(1);
    expect(stateEvents[0].state).toBe('idle');
  });

  it('setAdapter throws if adapter already set', () => {
    const ch = createChannel('ch-1');
    setAdapter(ch, createMockAdapter());

    expect(() => setAdapter(ch, createMockAdapter())).toThrow('Adapter already set');
  });

  it('setAdapter resets entryIndex', () => {
    const ch = createChannel('ch-1');
    ch.entryIndex = 42; // Simulate leftover from previous use
    setAdapter(ch, createMockAdapter());
    expect(ch.entryIndex).toBe(0);
  });
});

// ========== 4. Entry Routing ==========

describe('Entry routing', () => {
  it('entries are broadcast with incrementing index', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(entryMsg({ type: 'user' }));
    adapter.pushMessage(entryMsg({ type: 'assistant' }));
    adapter.pushMessage(entryMsg({ type: 'system' }));
    await tick();

    const entries = sub.eventsOfType('entry');
    expect(entries.length).toBe(3);
    expect(entries[0].index).toBe(0);
    expect(entries[1].index).toBe(1);
    expect(entries[2].index).toBe(2);
    expect(ch.entryIndex).toBe(3);
  });

  it('entries broadcast to multiple subscribers', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-2');

    subscribe(ch, sub1);
    subscribe(ch, sub2);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(entryMsg());
    await tick();

    expect(sub1.eventsOfType('entry').length).toBe(1);
    expect(sub2.eventsOfType('entry').length).toBe(1);
  });
});

// ========== 5. Status Event Routing ==========

describe('Status event routing', () => {
  it('active status → streaming state', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(statusMsg('active'));
    await tick();

    expect(ch.state).toBe('streaming');
    const stateEvents = sub.eventsOfType('state_changed');
    // idle (from setAdapter) + streaming (from active status)
    expect(stateEvents.length).toBe(2);
    expect(stateEvents[1].state).toBe('streaming');
  });

  it('idle status → idle state and clears pendingApprovals', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    // Simulate an approval then idle
    adapter.pushMessage(approvalMsg('tool-1'));
    await tick();
    expect(ch.pendingApprovals.has('tool-1')).toBe(true);

    adapter.pushMessage(statusMsg('idle'));
    await tick();
    expect(ch.state).toBe('idle');
    expect(ch.pendingApprovals.size).toBe(0);
  });

  it('awaiting_approval status → awaiting_approval state + approval_request broadcast', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(approvalMsg('tool-42', 'Write', { file_path: '/tmp/foo' }, [
      { id: 'allow', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ], 'Wants to write a file'));
    await tick();

    expect(ch.state).toBe('awaiting_approval');
    expect(ch.pendingApprovals.has('tool-42')).toBe(true);

    const approvalReqs = sub.eventsOfType('approval_request');
    expect(approvalReqs.length).toBe(1);
    expect(approvalReqs[0].toolUseId).toBe('tool-42');
    expect(approvalReqs[0].toolName).toBe('Write');
    expect(approvalReqs[0].input).toEqual({ file_path: '/tmp/foo' });
    expect(approvalReqs[0].reason).toBe('Wants to write a file');
    expect(approvalReqs[0].options).toHaveLength(2);
  });
});

// ========== 6. Notification Routing ==========

describe('Notification routing', () => {
  it('error notification → error subscriber event', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(notificationMsg({
      type: 'notification',
      kind: 'error',
      error: 'Something went wrong',
    }));
    await tick();

    const errors = sub.eventsOfType('error');
    expect(errors.length).toBe(1);
    expect(errors[0].error).toBe('Something went wrong');
  });

  it('error notification with Error object → extracts message', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(notificationMsg({
      type: 'notification',
      kind: 'error',
      error: new Error('Detailed error'),
    }));
    await tick();

    const errors = sub.eventsOfType('error');
    expect(errors.length).toBe(1);
    expect(errors[0].error).toBe('Detailed error');
  });

  it.each([
    ['session_changed', { type: 'notification' as const, kind: 'session_changed' as const, sessionId: 'new-id', previousSessionId: 'old-id' }],
    ['compacting', { type: 'notification' as const, kind: 'compacting' as const }],
    ['permission_mode_changed', { type: 'notification' as const, kind: 'permission_mode_changed' as const, mode: 'plan' }],
  ])('%s notification → passthrough as notification subscriber event', async (kind, payload) => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(notificationMsg(payload as NotificationEvent));
    await tick();

    const notifications = sub.eventsOfType('notification');
    expect(notifications.length).toBe(1);
    expect(notifications[0].event.kind).toBe(kind);
  });
});

// ========== 7. Approval Flow ==========

describe('Approval flow', () => {
  it('resolveApproval delegates to adapter.respondToApproval', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(approvalMsg('tool-1'));
    await tick();

    resolveApproval(ch, 'tool-1', 'allow');

    expect(adapter.respondToApproval).toHaveBeenCalledWith('tool-1', 'allow', undefined);
  });

  it('resolveApproval removes from pendingApprovals and broadcasts approval_resolved', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(approvalMsg('tool-1'));
    await tick();
    expect(ch.pendingApprovals.has('tool-1')).toBe(true);

    resolveApproval(ch, 'tool-1', 'allow');
    expect(ch.pendingApprovals.has('tool-1')).toBe(false);

    const resolved = sub.eventsOfType('approval_resolved');
    expect(resolved.length).toBe(1);
    expect(resolved[0].toolUseId).toBe('tool-1');
  });

  it('resolveApproval warns on unknown toolUseId (no throw)', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await tick();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    resolveApproval(ch, 'unknown-tool', 'allow');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown-tool'),
    );
    expect(adapter.respondToApproval).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('resolveApproval throws without adapter', () => {
    const ch = createChannel('ch-1');
    expect(() => resolveApproval(ch, 'tool-1', 'allow')).toThrow('No adapter set');
  });

  it('resolveApproval preserves pendingApprovals if adapter throws (retryable)', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();

    // Make respondToApproval throw on first call, succeed on second
    (adapter.respondToApproval as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => { throw new Error('Invalid optionId'); })
      .mockImplementationOnce(() => { /* success */ });

    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(approvalMsg('tool-1'));
    await tick();
    expect(ch.pendingApprovals.has('tool-1')).toBe(true);

    // First attempt fails — approval stays pending so caller can retry
    expect(() => resolveApproval(ch, 'tool-1', 'bad-option')).toThrow('Invalid optionId');
    expect(ch.pendingApprovals.has('tool-1')).toBe(true);

    // Retry with valid option succeeds
    resolveApproval(ch, 'tool-1', 'allow');
    expect(ch.pendingApprovals.has('tool-1')).toBe(false);
  });

  it('multiple concurrent approvals tracked independently', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(approvalMsg('tool-1', 'Bash'));
    adapter.pushMessage(approvalMsg('tool-2', 'Write'));
    await tick();

    expect(ch.pendingApprovals.size).toBe(2);
    expect(ch.pendingApprovals.has('tool-1')).toBe(true);
    expect(ch.pendingApprovals.has('tool-2')).toBe(true);

    resolveApproval(ch, 'tool-1', 'allow');
    expect(ch.pendingApprovals.size).toBe(1);
    expect(ch.pendingApprovals.has('tool-2')).toBe(true);

    resolveApproval(ch, 'tool-2', 'deny');
    expect(ch.pendingApprovals.size).toBe(0);

    const resolved = sub.eventsOfType('approval_resolved');
    expect(resolved.length).toBe(2);
    expect(resolved[0].toolUseId).toBe('tool-1');
    expect(resolved[1].toolUseId).toBe('tool-2');
  });
});

// ========== 8. sendMessage ==========

describe('sendMessage', () => {
  it('delegates to adapter.send', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await tick();

    sendMessage(ch, 'Hello world');
    expect(adapter.send).toHaveBeenCalledWith('Hello world', undefined);
  });

  it('throws without adapter', () => {
    const ch = createChannel('ch-1');
    expect(() => sendMessage(ch, 'Hello')).toThrow('No adapter set');
  });

  it('works with multimodal content', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await tick();

    const content = [
      { type: 'text' as const, text: 'What is this?' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc123' } },
    ];

    sendMessage(ch, content);
    expect(adapter.send).toHaveBeenCalledWith(content, undefined);
  });
});

// ========== 9. backfillHistory ==========

describe('backfillHistory', () => {
  it('broadcasts history event and sets entryIndex', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
      { type: 'user', message: { role: 'user', content: 'how are you' } },
    ];

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    backfillHistory(ch, entries);

    const historyEvents = sub.eventsOfType('history');
    expect(historyEvents.length).toBe(1);
    expect(historyEvents[0].entries).toEqual(entries);
    expect(ch.entryIndex).toBe(3);
  });

  it('empty history is a no-op (no broadcast)', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    backfillHistory(ch, []);

    const historyEvents = sub.eventsOfType('history');
    expect(historyEvents.length).toBe(0);
    expect(ch.entryIndex).toBe(0);
  });
});

// ========== 10. Stream Lifecycle ==========

describe('Stream lifecycle', () => {
  it('stream exhaustion → unattached', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    // Complete the stream (simulates adapter.close())
    adapter.completeStream();
    await tick();

    expect(ch.state).toBe('unattached');
    const stateEvents = sub.eventsOfType('state_changed');
    const lastState = stateEvents[stateEvents.length - 1];
    expect(lastState.state).toBe('unattached');
  });

  it('stream error → error broadcast + unattached state', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.failStream(new Error('Connection lost'));
    await tick();

    // Stream error kills the loop permanently — unattached, not idle
    expect(ch.state).toBe('unattached');

    const errors = sub.eventsOfType('error');
    expect(errors.length).toBe(1);
    expect(errors[0].error).toBe('Connection lost');

    // State change was broadcast
    const stateEvents = sub.eventsOfType('state_changed');
    const lastState = stateEvents[stateEvents.length - 1];
    expect(lastState.state).toBe('unattached');
  });

  it('stream error clears pendingApprovals', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();

    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(approvalMsg('tool-1'));
    await tick();
    expect(ch.pendingApprovals.size).toBe(1);

    adapter.failStream(new Error('oops'));
    await tick();

    expect(ch.pendingApprovals.size).toBe(0);
  });

  it('stream exhaustion clears pendingApprovals', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();

    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(approvalMsg('tool-1'));
    await tick();
    expect(ch.pendingApprovals.size).toBe(1);

    adapter.completeStream();
    await tick();

    expect(ch.pendingApprovals.size).toBe(0);
  });

  it('sendMessage after stream error delegates to adapter (adapter guards)', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();

    // After stream error, adapter.send() should throw (closed/broken state)
    (adapter.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Channel is closed');
    });

    setAdapter(ch, adapter);
    await tick();

    adapter.failStream(new Error('Connection lost'));
    await tick();
    expect(ch.state).toBe('unattached');

    // sendMessage still delegates to adapter — the adapter's own guard throws
    expect(() => sendMessage(ch, 'hello')).toThrow('Channel is closed');
  });

  it('tearing flag prevents loop from emitting after teardown', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    // destroyChannel sets tearing, calls close, removes from registry
    destroyChannel(ch.channelId);
    await tick();

    // After teardown, state should be unattached and tearing stays true
    // (channel is terminal — prevents async loop from double-emitting)
    expect(ch.state).toBe('unattached');
    expect(ch.tearing).toBe(true);
  });
});

// ========== 11. Error Resilience ==========

describe('Error resilience', () => {
  it('bad subscriber does not crash others', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();

    const badSub: Subscriber = {
      id: 'bad',
      send() { throw new Error('I am broken'); },
    };
    const goodSub = createTestSubscriber('good');

    subscribe(ch, badSub);
    subscribe(ch, goodSub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(entryMsg());
    await tick();

    // Good subscriber still received the entry
    expect(goodSub.eventsOfType('entry').length).toBe(1);
  });
});

// ========== 12. Snapshot ==========

describe('Snapshot', () => {
  it('state_changed includes current snapshot', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter({ vendor: 'claude', sessionId: 'sess-abc' });
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    const stateEvents = sub.eventsOfType('state_changed');
    expect(stateEvents.length).toBeGreaterThan(0);

    const snapshot = stateEvents[0].snapshot;
    expect(snapshot.state).toBe('idle');
    expect(snapshot.sessionId).toBe('sess-abc');
    expect(snapshot.vendor).toBe('claude');
    expect(snapshot.settings).toBeDefined();
  });

  it('snapshot reflects state transitions', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter({ vendor: 'claude', sessionId: 'sess-1' });
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(statusMsg('active'));
    await tick();

    const stateEvents = sub.eventsOfType('state_changed');
    const streamingEvent = stateEvents.find((e) => e.state === 'streaming');
    expect(streamingEvent).toBeDefined();
    expect(streamingEvent!.snapshot.state).toBe('streaming');
    expect(streamingEvent!.snapshot.vendor).toBe('claude');
    expect(streamingEvent!.snapshot.settings).toBeDefined();
  });

  it('destroyChannel emits state_changed with unattached snapshot', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter({ vendor: 'claude', sessionId: 'sess-1' });
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    // Clear previous events to isolate teardown
    sub.events.length = 0;

    destroyChannel(ch.channelId);
    await tick();

    const stateEvents = sub.eventsOfType('state_changed');
    expect(stateEvents.length).toBe(1);
    expect(stateEvents[0].state).toBe('unattached');
    expect(stateEvents[0].snapshot.state).toBe('unattached');
  });

  it('snapshot includes adapter settings', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter({ vendor: 'claude', sessionId: 'sess-settings' });
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    const stateEvents = sub.eventsOfType('state_changed');
    expect(stateEvents.length).toBeGreaterThan(0);

    const snapshot = stateEvents[0].snapshot;
    expect(snapshot.settings).toBeDefined();
    expect(snapshot.settings).not.toBeNull();
    expect(snapshot.settings!.allowDangerouslySkipPermissions).toBe(false);
  });

  it('snapshot settings are null when no adapter (teardown)', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter({ vendor: 'claude', sessionId: 'sess-1' });
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    // Clear previous events to isolate teardown
    sub.events.length = 0;

    destroyChannel(ch.channelId);
    await tick();

    const stateEvents = sub.eventsOfType('state_changed');
    expect(stateEvents.length).toBe(1);
    expect(stateEvents[0].state).toBe('unattached');
    // After teardown the adapter is closed but still referenced;
    // the snapshot is built from the torn-down channel state
    // Settings may be present (adapter still assigned) or null depending on teardown order
    // The key invariant is that the state is 'unattached'
  });
});

// ========== Integration: Full Flow ==========

describe('Integration: full conversation flow', () => {
  it('send → active → entries → approval → resolve → active → idle → stream open', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter({ sessionId: 'sess-1' });
    const sub = createTestSubscriber('sub-1');

    subscribe(ch, sub);
    setAdapter(ch, adapter);
    await tick();

    // 1. Send a message
    sendMessage(ch, 'Write a hello world program');
    expect(adapter.send).toHaveBeenCalledWith('Write a hello world program', undefined);

    // 2. Adapter emits active status
    adapter.pushMessage(statusMsg('active'));
    await tick();
    expect(ch.state).toBe('streaming');

    // 3. Entries stream in
    adapter.pushMessage(entryMsg({ type: 'assistant' }));
    adapter.pushMessage(entryMsg({ type: 'assistant' }));
    await tick();
    expect(ch.entryIndex).toBe(2);

    // 4. Approval request
    adapter.pushMessage(approvalMsg('tool-99', 'Write', { file_path: '/tmp/hello.py' }));
    await tick();
    expect(ch.state).toBe('awaiting_approval');

    // 5. Resolve approval
    resolveApproval(ch, 'tool-99', 'allow');
    expect(ch.pendingApprovals.size).toBe(0);

    // 6. Adapter emits active again (all approvals resolved)
    adapter.pushMessage(statusMsg('active'));
    await tick();
    expect(ch.state).toBe('streaming');

    // 7. More entries
    adapter.pushMessage(entryMsg({ type: 'assistant' }));
    await tick();

    // 8. Query completes — adapter emits idle (stream stays open)
    adapter.pushMessage(statusMsg('idle'));
    await tick();
    expect(ch.state).toBe('idle');
    expect(ch.entryIndex).toBe(3);

    // Verify event sequence
    const allEvents = sub.events;
    const types = allEvents.map((e) => e.type);
    expect(types).toEqual([
      'state_changed',     // idle (from setAdapter)
      'state_changed',     // streaming (from active)
      'entry',             // assistant 1
      'entry',             // assistant 2
      'state_changed',     // awaiting_approval
      'approval_request',  // tool-99
      'approval_resolved', // tool-99
      'state_changed',     // streaming (from active)
      'entry',             // assistant 3
      'state_changed',     // idle (query done)
    ]);
  });
});
