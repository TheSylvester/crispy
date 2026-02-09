/**
 * Tests for Session Manager — Cross-Vendor Orchestration Layer
 *
 * Tests mock at the AgentAdapter boundary. A MockAdapter uses
 * AsyncIterableQueue<ChannelMessage> as the controllable output stream.
 * All adapter methods are vi.fn() stubs.
 *
 * Two test groups:
 * A) Happy path — how the public API is supposed to work
 * B) Regression tests — prove specific bug fixes hold
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncIterableQueue } from '../src/core/async-iterable-queue.js';
import type { AgentAdapter, SessionInfo, ChannelMessage } from '../src/core/agent-adapter.js';
import type { TranscriptEntry, MessageContent, Vendor } from '../src/core/transcript.js';
import type { ChannelStatus } from '../src/core/channel-events.js';
import type { Subscriber, SubscriberEvent } from '../src/core/session-channel.js';

import {
  _resetRegistry as _resetChannelRegistry,
} from '../src/core/session-channel.js';

import {
  registerAdapter,
  unregisterAdapter,
  getAdapter,
  getAdapters,
  findSession,
  loadSession,
  listAllSessions,
  subscribeSession,
  sendToSession,
  setSessionModel,
  setSessionPermissions,
  interruptSession,
  closeSession,
  _resetRegistry,
} from '../src/core/session-manager.js';

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
  sessions?: SessionInfo[];
  historyEntries?: TranscriptEntry[];
}): MockAdapter {
  const queue = new AsyncIterableQueue<ChannelMessage>();
  const vendor: Vendor = options?.vendor ?? 'claude';
  const sessionId = options?.sessionId;
  const sessions = options?.sessions ?? [];
  const historyEntries = options?.historyEntries ?? [];
  let status: ChannelStatus = 'idle';

  return {
    vendor,
    get sessionId() { return sessionId; },
    get status() { return status; },
    outputQueue: queue,

    messages(): AsyncIterable<ChannelMessage> {
      return queue;
    },

    send: vi.fn((_content: MessageContent) => {}),

    respondToApproval: vi.fn((_toolUseId: string, _optionId: string) => {}),

    close: vi.fn(() => {
      queue.done();
    }),

    loadHistory: vi.fn(async (_id: string): Promise<TranscriptEntry[]> => {
      return historyEntries;
    }),

    findSession: vi.fn((_id: string): SessionInfo | undefined => {
      return sessions.find((s) => s.sessionId === _id);
    }),

    listSessions: vi.fn((): SessionInfo[] => {
      return sessions;
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

/** Create a SessionInfo object with sensible defaults. */
function makeSessionInfo(overrides: Partial<SessionInfo> & { sessionId: string; vendor: Vendor }): SessionInfo {
  return {
    path: `/sessions/${overrides.sessionId}`,
    projectSlug: 'test-project',
    modifiedAt: new Date('2025-01-15T12:00:00Z'),
    size: 1024,
    ...overrides,
  };
}

/** Wait for microtasks to settle (lets async loop process enqueued messages). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ============================================================================
// Lifecycle
// ============================================================================

beforeEach(() => {
  _resetRegistry();
  _resetChannelRegistry();
});

afterEach(() => {
  _resetRegistry();
  _resetChannelRegistry();
});

// ============================================================================
// A) Happy Path Tests
// ============================================================================

// ========== 1. Adapter Registry ==========

describe('Adapter registry', () => {
  it('registerAdapter adds an adapter retrievable by vendor', () => {
    const adapter = createMockAdapter({ vendor: 'claude' });
    registerAdapter(adapter);

    expect(getAdapter('claude')).toBe(adapter);
  });

  it('registerAdapter throws on duplicate vendor', () => {
    const adapter1 = createMockAdapter({ vendor: 'claude' });
    const adapter2 = createMockAdapter({ vendor: 'claude' });

    registerAdapter(adapter1);
    expect(() => registerAdapter(adapter2)).toThrow('already registered');
  });

  it('unregisterAdapter removes the adapter', () => {
    const adapter = createMockAdapter({ vendor: 'claude' });
    registerAdapter(adapter);
    unregisterAdapter('claude');

    expect(getAdapter('claude')).toBeUndefined();
  });

  it('unregisterAdapter is no-op for unregistered vendor', () => {
    expect(() => unregisterAdapter('gemini')).not.toThrow();
  });

  it('getAdapters returns all registered adapters', () => {
    const claude = createMockAdapter({ vendor: 'claude' });
    const codex = createMockAdapter({ vendor: 'codex' });

    registerAdapter(claude);
    registerAdapter(codex);

    const all = getAdapters();
    expect(all).toHaveLength(2);
    expect(all).toContain(claude);
    expect(all).toContain(codex);
  });

  it('getAdapter returns undefined for unregistered vendor', () => {
    expect(getAdapter('gemini')).toBeUndefined();
  });
});

// ========== 2. Cross-Vendor Discovery ==========

describe('findSession', () => {
  it('finds session from the correct vendor', () => {
    const claudeSession = makeSessionInfo({ sessionId: 'sess-c1', vendor: 'claude' });
    const codexSession = makeSessionInfo({ sessionId: 'sess-x1', vendor: 'codex' });

    const claude = createMockAdapter({ vendor: 'claude', sessions: [claudeSession] });
    const codex = createMockAdapter({ vendor: 'codex', sessions: [codexSession] });

    registerAdapter(claude);
    registerAdapter(codex);

    const found = findSession('sess-x1');
    expect(found).toBeDefined();
    expect(found!.vendor).toBe('codex');
    expect(found!.sessionId).toBe('sess-x1');
  });

  it('returns undefined when no vendor claims the session', () => {
    const claude = createMockAdapter({ vendor: 'claude', sessions: [] });
    registerAdapter(claude);

    expect(findSession('nonexistent')).toBeUndefined();
  });

  it('iterates adapters until one claims the session', () => {
    const claudeSession = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [claudeSession] });
    const codex = createMockAdapter({ vendor: 'codex', sessions: [] });

    registerAdapter(codex);
    registerAdapter(claude);

    const found = findSession('sess-1');
    expect(found).toBeDefined();
    expect(found!.vendor).toBe('claude');
    // codex.findSession was called but returned undefined
    expect(codex.findSession).toHaveBeenCalledWith('sess-1');
  });
});

describe('listAllSessions', () => {
  it('aggregates sessions from all vendors sorted by modifiedAt descending', () => {
    const s1 = makeSessionInfo({
      sessionId: 'sess-old',
      vendor: 'claude',
      modifiedAt: new Date('2025-01-01T00:00:00Z'),
    });
    const s2 = makeSessionInfo({
      sessionId: 'sess-new',
      vendor: 'codex',
      modifiedAt: new Date('2025-06-01T00:00:00Z'),
    });
    const s3 = makeSessionInfo({
      sessionId: 'sess-mid',
      vendor: 'claude',
      modifiedAt: new Date('2025-03-01T00:00:00Z'),
    });

    const claude = createMockAdapter({ vendor: 'claude', sessions: [s1, s3] });
    const codex = createMockAdapter({ vendor: 'codex', sessions: [s2] });

    registerAdapter(claude);
    registerAdapter(codex);

    const all = listAllSessions();
    expect(all).toHaveLength(3);
    expect(all[0].sessionId).toBe('sess-new');
    expect(all[1].sessionId).toBe('sess-mid');
    expect(all[2].sessionId).toBe('sess-old');
  });

  it('returns empty array when no adapters registered', () => {
    expect(listAllSessions()).toEqual([]);
  });
});

describe('loadSession (read-only)', () => {
  it('finds the vendor and delegates to adapter.loadHistory', async () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
    ];
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({
      vendor: 'claude',
      sessions: [session],
      historyEntries: entries,
    });

    registerAdapter(claude);

    const result = await loadSession('sess-1');
    expect(result).toEqual(entries);
    expect(claude.loadHistory).toHaveBeenCalledWith('sess-1');
  });

  it('returns empty array when session not found', async () => {
    const claude = createMockAdapter({ vendor: 'claude', sessions: [] });
    registerAdapter(claude);

    const result = await loadSession('nonexistent');
    expect(result).toEqual([]);
  });

  it('does not create a channel (read-only)', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [session] });
    registerAdapter(claude);

    await loadSession('sess-1');

    // Sending to this session should throw because no channel was opened
    expect(() => sendToSession('sess-1', 'hello')).toThrow('No open channel');
  });
});

// ========== 3. subscribeSession ==========

describe('subscribeSession', () => {
  it('creates a channel, wires the adapter, backfills history, and subscribes', async () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
    ];
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({
      vendor: 'claude',
      sessions: [session],
      historyEntries: entries,
    });
    registerAdapter(claude);

    const sub = createTestSubscriber('sub-1');
    const channel = await subscribeSession('sess-1', sub);

    expect(channel).toBeDefined();
    expect(channel.channelId).toBe('sess-1');
    expect(channel.adapter).toBe(claude);

    // loadHistory was called to backfill the transcript
    expect(claude.loadHistory).toHaveBeenCalledWith('sess-1');

    // The subscriber is added after the channel is fully initialized
    // (history broadcast happens during init, before subscribe),
    // so the subscriber doesn't receive the history event directly.
    // What matters is that the channel's entryIndex reflects the history.
    expect(channel.entryIndex).toBe(2);

    // Subscriber is registered
    expect(channel.subscribers.has('sub-1')).toBe(true);

    // Channel transitioned to idle (from setAdapter)
    expect(channel.state).not.toBe('unattached');
  });

  it('reuses existing channel for second subscriber', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [session] });
    registerAdapter(claude);

    const sub1 = createTestSubscriber('sub-1');
    const channel1 = await subscribeSession('sess-1', sub1);

    const sub2 = createTestSubscriber('sub-2');
    const channel2 = await subscribeSession('sess-1', sub2);

    // Same channel reused
    expect(channel2).toBe(channel1);
    expect(channel2.subscribers.size).toBe(2);
  });

  it('throws when session not found across any vendor', async () => {
    const claude = createMockAdapter({ vendor: 'claude', sessions: [] });
    registerAdapter(claude);

    const sub = createTestSubscriber('sub-1');
    await expect(subscribeSession('nonexistent', sub)).rejects.toThrow('not found');
  });
});

// ========== 4. Session-Keyed Live Operations ==========

describe('sendToSession', () => {
  it('delegates to the channel adapter send()', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [session] });
    registerAdapter(claude);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    sendToSession('sess-1', 'Hello world');
    expect(claude.send).toHaveBeenCalledWith('Hello world');
  });

  it('throws when no channel is open', () => {
    expect(() => sendToSession('nonexistent', 'hello')).toThrow('No open channel');
  });
});

describe('setSessionModel', () => {
  it('delegates to adapter.setModel()', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [session] });
    registerAdapter(claude);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    await setSessionModel('sess-1', 'opus');
    expect(claude.setModel).toHaveBeenCalledWith('opus');
  });

  it('throws when no channel is open', async () => {
    await expect(setSessionModel('nonexistent', 'opus')).rejects.toThrow('No open channel');
  });
});

describe('setSessionPermissions', () => {
  it('delegates to adapter.setPermissionMode()', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [session] });
    registerAdapter(claude);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    await setSessionPermissions('sess-1', 'acceptEdits');
    expect(claude.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
  });

  it('throws when no channel is open', async () => {
    await expect(setSessionPermissions('nonexistent', 'plan')).rejects.toThrow('No open channel');
  });
});

describe('interruptSession', () => {
  it('delegates to adapter.interrupt()', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [session] });
    registerAdapter(claude);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    await interruptSession('sess-1');
    expect(claude.interrupt).toHaveBeenCalled();
  });

  it('throws when no channel is open', async () => {
    await expect(interruptSession('nonexistent')).rejects.toThrow('No open channel');
  });
});

describe('closeSession', () => {
  it('tears down channel and removes from registry', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [session] });
    registerAdapter(claude);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    closeSession('sess-1');

    // Channel is gone — operations should throw
    expect(() => sendToSession('sess-1', 'hello')).toThrow('No open channel');

    // Subscriber received state_changed to unattached (from teardown)
    const stateEvents = sub.eventsOfType('state_changed');
    const lastState = stateEvents[stateEvents.length - 1];
    expect(lastState.state).toBe('unattached');
  });

  it('is no-op if no channel is open for sessionId', () => {
    expect(() => closeSession('nonexistent')).not.toThrow();
  });
});

describe('_resetRegistry', () => {
  it('clears all adapters and sessions', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [session] });
    registerAdapter(claude);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    _resetRegistry();

    expect(getAdapter('claude')).toBeUndefined();
    expect(getAdapters()).toHaveLength(0);
    expect(() => sendToSession('sess-1', 'hello')).toThrow('No open channel');
  });
});

// ============================================================================
// B) Regression Tests
// ============================================================================

// ========== Bug 1: Single-consumer enforcement ==========

describe('Regression: single-consumer enforcement', () => {
  it('opening a second live session for the same vendor throws', async () => {
    const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const s2 = makeSessionInfo({ sessionId: 'sess-2', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [s1, s2] });
    registerAdapter(claude);

    const sub1 = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub1);

    const sub2 = createTestSubscriber('sub-2');
    await expect(subscribeSession('sess-2', sub2)).rejects.toThrow(
      /already has a live session/,
    );
  });

  it('closing the first session allows opening a second for the same vendor', async () => {
    const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const s2 = makeSessionInfo({ sessionId: 'sess-2', vendor: 'claude' });
    // Need separate adapters because the first adapter's queue will be done() after close
    // Actually, the session manager uses the same adapter instance for both sessions.
    // After closing the first channel, the adapter's queue is done'd by destroyChannel.
    // For this test we need the adapter's messages() to return the queue,
    // but AsyncIterableQueue is single-consumer and single-use.
    // The real code creates one channel per session but reuses the adapter.
    // However, the mock adapter's queue.done() is called by close().
    // We need a mock adapter where close() is intercepted but the queue can be reused.
    //
    // Actually, let's look at the flow: closeSession calls destroyChannel which calls
    // teardown which calls adapter.close(). The mock's close() calls queue.done().
    // Then when openChannel is called for sess-2, it calls setAdapter which starts
    // the consumption loop which calls adapter.messages() which returns the same queue
    // (now done). The loop immediately exits and the channel goes to unattached.
    //
    // In the real system, the adapter would manage its own internal queue and
    // messages() could potentially be called again. For this test, we need
    // a mock that can produce a fresh queue on each messages() call.
    const queues: AsyncIterableQueue<ChannelMessage>[] = [];
    let queueIndex = 0;

    const freshAdapter: MockAdapter = {
      vendor: 'claude',
      get sessionId() { return undefined; },
      get status(): ChannelStatus { return 'idle'; },
      get outputQueue() { return queues[queues.length - 1]; },

      messages(): AsyncIterable<ChannelMessage> {
        if (queueIndex >= queues.length) {
          queues.push(new AsyncIterableQueue<ChannelMessage>());
        }
        return queues[queueIndex++];
      },

      send: vi.fn(),
      respondToApproval: vi.fn(),
      close: vi.fn(() => {
        // Don't done() the queue — just a mock close
        if (queues.length > 0) {
          queues[queues.length - 1].done();
        }
      }),

      loadHistory: vi.fn(async () => []),
      findSession: vi.fn((id: string) =>
        [s1, s2].find((s) => s.sessionId === id),
      ),
      listSessions: vi.fn(() => [s1, s2]),
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),

      pushMessage(msg: ChannelMessage) {
        queues[queues.length - 1]?.enqueue(msg);
      },
      completeStream() {
        queues[queues.length - 1]?.done();
      },
      failStream(err: Error) {
        queues[queues.length - 1]?.error(err);
      },
    };

    registerAdapter(freshAdapter);

    const sub1 = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub1);

    // Close first session
    closeSession('sess-1');
    await tick();

    // Now opening second session for same vendor should work
    const sub2 = createTestSubscriber('sub-2');
    const channel2 = await subscribeSession('sess-2', sub2);
    expect(channel2).toBeDefined();
    expect(channel2.channelId).toBe('sess-2');
  });

  it('different vendors can have simultaneous live sessions', async () => {
    const claudeSession = makeSessionInfo({ sessionId: 'sess-c1', vendor: 'claude' });
    const codexSession = makeSessionInfo({ sessionId: 'sess-x1', vendor: 'codex' });

    const claude = createMockAdapter({ vendor: 'claude', sessions: [claudeSession] });
    const codex = createMockAdapter({ vendor: 'codex', sessions: [codexSession] });

    registerAdapter(claude);
    registerAdapter(codex);

    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-2');

    const ch1 = await subscribeSession('sess-c1', sub1);
    const ch2 = await subscribeSession('sess-x1', sub2);

    expect(ch1.channelId).toBe('sess-c1');
    expect(ch2.channelId).toBe('sess-x1');
  });
});

// ========== Bug 2: loadHistory failure cleanup ==========

describe('Regression: loadHistory failure cleanup', () => {
  it('failed loadHistory cleans up channel so next call succeeds', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });

    // Use a fresh-queue adapter because the first channel will be destroyed
    const queues: AsyncIterableQueue<ChannelMessage>[] = [];
    let queueIndex = 0;

    const adapter: MockAdapter = {
      vendor: 'claude',
      get sessionId() { return undefined; },
      get status(): ChannelStatus { return 'idle'; },
      get outputQueue() { return queues[queues.length - 1]; },

      messages(): AsyncIterable<ChannelMessage> {
        if (queueIndex >= queues.length) {
          queues.push(new AsyncIterableQueue<ChannelMessage>());
        }
        return queues[queueIndex++];
      },

      send: vi.fn(),
      respondToApproval: vi.fn(),
      close: vi.fn(() => {
        if (queues.length > 0) {
          queues[queues.length - 1].done();
        }
      }),

      // First call fails, second succeeds
      loadHistory: vi.fn()
        .mockRejectedValueOnce(new Error('Disk read failed'))
        .mockResolvedValueOnce([
          { type: 'user', message: { role: 'user', content: 'hello' } },
        ]) as unknown as AgentAdapter['loadHistory'],

      findSession: vi.fn((id: string) =>
        id === session.sessionId ? session : undefined,
      ),
      listSessions: vi.fn(() => [session]),
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),

      pushMessage(msg: ChannelMessage) {
        queues[queues.length - 1]?.enqueue(msg);
      },
      completeStream() {
        queues[queues.length - 1]?.done();
      },
      failStream(err: Error) {
        queues[queues.length - 1]?.error(err);
      },
    };

    registerAdapter(adapter);

    const sub1 = createTestSubscriber('sub-1');

    // First call should fail
    await expect(subscribeSession('sess-1', sub1)).rejects.toThrow('Disk read failed');

    // The poisoned channel should have been cleaned up, so a retry should work
    const sub2 = createTestSubscriber('sub-2');
    const channel = await subscribeSession('sess-1', sub2);
    expect(channel).toBeDefined();
    expect(channel.channelId).toBe('sess-1');

    // loadHistory was called successfully on the second attempt
    expect(adapter.loadHistory).toHaveBeenCalledTimes(2);

    // The subscriber is registered on the fresh channel
    expect(channel.subscribers.has('sub-2')).toBe(true);
  });
});

// ========== Bug 3: Terminal/dead channel eviction ==========

describe('Regression: terminal/dead channel eviction', () => {
  it('evicts unattached channel and creates a fresh one', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });

    // Multi-queue adapter (each messages() call gets a new queue)
    const queues: AsyncIterableQueue<ChannelMessage>[] = [];
    let queueIndex = 0;

    const adapter: MockAdapter = {
      vendor: 'claude',
      get sessionId() { return undefined; },
      get status(): ChannelStatus { return 'idle'; },
      get outputQueue() { return queues[queues.length - 1]; },

      messages(): AsyncIterable<ChannelMessage> {
        if (queueIndex >= queues.length) {
          queues.push(new AsyncIterableQueue<ChannelMessage>());
        }
        return queues[queueIndex++];
      },

      send: vi.fn(),
      respondToApproval: vi.fn(),
      close: vi.fn(() => {
        if (queues.length > 0) {
          queues[queues.length - 1].done();
        }
      }),

      loadHistory: vi.fn(async () => []),
      findSession: vi.fn((id: string) =>
        id === session.sessionId ? session : undefined,
      ),
      listSessions: vi.fn(() => [session]),
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),

      pushMessage(msg: ChannelMessage) {
        queues[queues.length - 1]?.enqueue(msg);
      },
      completeStream() {
        queues[queues.length - 1]?.done();
      },
      failStream(err: Error) {
        queues[queues.length - 1]?.error(err);
      },
    };

    registerAdapter(adapter);

    // Open session and get channel
    const sub1 = createTestSubscriber('sub-1');
    const channel1 = await subscribeSession('sess-1', sub1);

    // Simulate stream exhaustion -> channel goes to 'unattached'
    queues[0].done();
    await tick();
    expect(channel1.state).toBe('unattached');

    // subscribeSession should evict the dead channel and create a fresh one
    const sub2 = createTestSubscriber('sub-2');
    const channel2 = await subscribeSession('sess-1', sub2);

    expect(channel2).not.toBe(channel1); // Fresh channel, not the dead one
    expect(channel2.state).not.toBe('unattached');
  });
});

// ========== Bug 4: unregisterAdapter closes live sessions ==========

describe('Regression: unregisterAdapter closes live sessions', () => {
  it('unregistering a vendor closes all live sessions for that vendor', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claude = createMockAdapter({ vendor: 'claude', sessions: [session] });
    registerAdapter(claude);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    // Verify channel is live
    expect(() => sendToSession('sess-1', 'hi')).not.toThrow();

    // Unregister the vendor
    unregisterAdapter('claude');

    // Channel should be torn down
    expect(() => sendToSession('sess-1', 'hello')).toThrow('No open channel');

    // Adapter should be gone
    expect(getAdapter('claude')).toBeUndefined();

    // Subscriber received state_changed to unattached
    const stateEvents = sub.eventsOfType('state_changed');
    const lastState = stateEvents[stateEvents.length - 1];
    expect(lastState.state).toBe('unattached');
  });

  it('unregistering vendor does not affect other vendors', async () => {
    const claudeSession = makeSessionInfo({ sessionId: 'sess-c1', vendor: 'claude' });
    const codexSession = makeSessionInfo({ sessionId: 'sess-x1', vendor: 'codex' });

    const claude = createMockAdapter({ vendor: 'claude', sessions: [claudeSession] });
    const codex = createMockAdapter({ vendor: 'codex', sessions: [codexSession] });

    registerAdapter(claude);
    registerAdapter(codex);

    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-2');

    await subscribeSession('sess-c1', sub1);
    await subscribeSession('sess-x1', sub2);

    // Unregister claude
    unregisterAdapter('claude');

    // Claude session is gone
    expect(() => sendToSession('sess-c1', 'hi')).toThrow('No open channel');

    // Codex session is still alive
    expect(() => sendToSession('sess-x1', 'hi')).not.toThrow();
  });
});

// ========== Bug 5: Concurrent subscribeSession coalescing ==========

describe('Regression: concurrent subscribeSession coalescing', () => {
  it('two concurrent subscribeSession calls coalesce into one channel', async () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
    ];
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });

    // Use a slow loadHistory to create a window for concurrency
    const adapter = createMockAdapter({ vendor: 'claude', sessions: [session] });
    (adapter.loadHistory as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<TranscriptEntry[]>((resolve) => setTimeout(() => resolve(entries), 50)),
    );
    registerAdapter(adapter);

    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-2');

    // Launch both concurrently
    const [channel1, channel2] = await Promise.all([
      subscribeSession('sess-1', sub1),
      subscribeSession('sess-1', sub2),
    ]);

    // Both got the same channel
    expect(channel1).toBe(channel2);

    // Both are subscribed
    expect(channel1.subscribers.size).toBe(2);
    expect(channel1.subscribers.has('sub-1')).toBe(true);
    expect(channel1.subscribers.has('sub-2')).toBe(true);

    // loadHistory was called only once (not twice)
    expect(adapter.loadHistory).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls share a single channel initialization', async () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
    ];
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });

    const adapter = createMockAdapter({ vendor: 'claude', sessions: [session] });
    (adapter.loadHistory as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<TranscriptEntry[]>((resolve) => setTimeout(() => resolve(entries), 20)),
    );
    registerAdapter(adapter);

    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-2');

    const [ch1, ch2] = await Promise.all([
      subscribeSession('sess-1', sub1),
      subscribeSession('sess-1', sub2),
    ]);

    // Both got the same channel
    expect(ch1).toBe(ch2);

    // loadHistory was called only once (coalesced)
    expect(adapter.loadHistory).toHaveBeenCalledTimes(1);

    // Note: the history broadcast happens during init before either subscriber
    // is added (subscribe() runs after the init promise resolves), so neither
    // subscriber receives the history event. What matters is that the channel's
    // entryIndex reflects the loaded history.
    expect(ch1.entryIndex).toBe(1);

    // Both subscribers are registered
    expect(ch1.subscribers.has('sub-1')).toBe(true);
    expect(ch1.subscribers.has('sub-2')).toBe(true);
  });

  it('if init fails, both concurrent callers get the error', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });

    // Fresh-queue adapter so the destroyed channel doesn't block
    const queues: AsyncIterableQueue<ChannelMessage>[] = [];
    let queueIndex = 0;

    const adapter: MockAdapter = {
      vendor: 'claude',
      get sessionId() { return undefined; },
      get status(): ChannelStatus { return 'idle'; },
      get outputQueue() { return queues[queues.length - 1]; },

      messages(): AsyncIterable<ChannelMessage> {
        if (queueIndex >= queues.length) {
          queues.push(new AsyncIterableQueue<ChannelMessage>());
        }
        return queues[queueIndex++];
      },

      send: vi.fn(),
      respondToApproval: vi.fn(),
      close: vi.fn(() => {
        if (queues.length > 0) {
          queues[queues.length - 1].done();
        }
      }),
      loadHistory: vi.fn(
        () => new Promise<TranscriptEntry[]>((_, reject) =>
          setTimeout(() => reject(new Error('Boom')), 20),
        ),
      ),
      findSession: vi.fn((id: string) =>
        id === session.sessionId ? session : undefined,
      ),
      listSessions: vi.fn(() => [session]),
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),

      pushMessage(msg: ChannelMessage) {
        queues[queues.length - 1]?.enqueue(msg);
      },
      completeStream() {
        queues[queues.length - 1]?.done();
      },
      failStream(err: Error) {
        queues[queues.length - 1]?.error(err);
      },
    };

    registerAdapter(adapter);

    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-2');

    const results = await Promise.allSettled([
      subscribeSession('sess-1', sub1),
      subscribeSession('sess-1', sub2),
    ]);

    // Both should have rejected
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect((results[0] as PromiseRejectedResult).reason.message).toBe('Boom');
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('Boom');
  });
});
