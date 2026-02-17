/**
 * Tests for Session Manager — Cross-Vendor Orchestration Layer
 *
 * Tests mock at the AgentAdapter + VendorDiscovery boundary.
 * MockDiscovery covers stateless ops (findSession, listSessions, loadHistory).
 * MockAdapter covers live session ops (messages, send, close, etc.) using
 * AsyncIterableQueue<ChannelMessage> as the controllable output stream.
 * All methods are vi.fn() stubs.
 *
 * Two test groups:
 * A) Happy path — how the public API is supposed to work
 * B) Regression tests — prove specific bug fixes hold
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncIterableQueue } from '../src/core/async-iterable-queue.js';
import type { AgentAdapter, AdapterSettings, SessionInfo, ChannelMessage, VendorDiscovery } from '../src/core/agent-adapter.js';
import type { TranscriptEntry, MessageContent, Vendor } from '../src/core/transcript.js';
import type { ChannelStatus, HistoryMessage, ChannelCatchupMessage } from '../src/core/channel-events.js';
import type { Subscriber } from '../src/core/session-channel.js';

/** Union of all messages a subscriber can receive. */
type SubscriberMessage = ChannelMessage | HistoryMessage | ChannelCatchupMessage;

import {
  _resetRegistry as _resetChannelRegistry,
} from '../src/core/session-channel.js';

import {
  registerAdapter,
  unregisterAdapter,
  getDiscovery,
  getDiscoveries,
  findSession,
  loadSession,
  listAllSessions,
  subscribeSession,
  sendToSession,
  setSessionModel,
  interruptSession,
  closeSession,
  _resetRegistry,
} from '../src/core/session-manager.js';

// ============================================================================
// Mock Discovery
// ============================================================================

interface MockDiscoveryOptions {
  vendor?: Vendor;
  sessions?: SessionInfo[];
  historyEntries?: TranscriptEntry[];
}

function createMockDiscovery(options?: MockDiscoveryOptions): VendorDiscovery & {
  findSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  loadHistory: ReturnType<typeof vi.fn>;
} {
  const vendor: Vendor = options?.vendor ?? 'claude';
  const sessions = options?.sessions ?? [];
  const historyEntries = options?.historyEntries ?? [];

  return {
    vendor,
    findSession: vi.fn((_id: string): SessionInfo | undefined => {
      return sessions.find((s) => s.sessionId === _id);
    }),
    listSessions: vi.fn((): SessionInfo[] => {
      return sessions;
    }),
    loadHistory: vi.fn(async (_id: string): Promise<TranscriptEntry[]> => {
      return historyEntries;
    }),
  } as VendorDiscovery & {
    findSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    loadHistory: ReturnType<typeof vi.fn>;
  };
}

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

interface MockAdapterOptions {
  vendor?: Vendor;
  sessionId?: string;
}

function createMockAdapter(options?: MockAdapterOptions): MockAdapter {
  const queue = new AsyncIterableQueue<ChannelMessage>();
  const vendor: Vendor = options?.vendor ?? 'claude';
  const sessionId = options?.sessionId;
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

    send: vi.fn((_content: MessageContent) => {}),

    respondToApproval: vi.fn((_toolUseId: string, _optionId: string) => {}),

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

/**
 * Create a factory that captures the last adapter it created.
 * Tests can call lastCreated() to get the factory-created adapter
 * (the one actually wired into the channel).
 */
function createCapturingFactory(options?: { vendor?: Vendor }) {
  let last: MockAdapter | undefined;
  return {
    factory: (_sessionId: string) => {
      last = createMockAdapter(options);
      return last;
    },
    lastCreated: () => last!,
  };
}

// ============================================================================
// Test Subscriber
// ============================================================================

interface TestSubscriber extends Subscriber {
  events: SubscriberMessage[];
  eventsOfType<T extends SubscriberMessage['type']>(
    type: T,
  ): Extract<SubscriberMessage, { type: T }>[];
}

function createTestSubscriber(id: string): TestSubscriber {
  const events: SubscriberMessage[] = [];
  return {
    id,
    events,
    send(event: SubscriberMessage): void {
      events.push(event);
    },
    eventsOfType<T extends SubscriberMessage['type']>(
      type: T,
    ): Extract<SubscriberMessage, { type: T }>[] {
      return events.filter((e) => e.type === type) as Extract<SubscriberMessage, { type: T }>[];
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
  it('registerAdapter adds a discovery retrievable by vendor', () => {
    const discovery = createMockDiscovery({ vendor: 'claude' });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    expect(getDiscovery('claude')).toBe(discovery);
  });

  it('registerAdapter throws on duplicate vendor', () => {
    const discovery1 = createMockDiscovery({ vendor: 'claude' });
    const discovery2 = createMockDiscovery({ vendor: 'claude' });

    registerAdapter(discovery1, () => createMockAdapter({ vendor: 'claude' }));
    expect(() => registerAdapter(discovery2, () => createMockAdapter({ vendor: 'claude' }))).toThrow('already registered');
  });

  it('unregisterAdapter removes the discovery', () => {
    const discovery = createMockDiscovery({ vendor: 'claude' });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));
    unregisterAdapter('claude');

    expect(getDiscovery('claude')).toBeUndefined();
  });

  it('unregisterAdapter is no-op for unregistered vendor', () => {
    expect(() => unregisterAdapter('gemini')).not.toThrow();
  });

  it('getDiscoveries returns all registered discovery objects', () => {
    const claudeDiscovery = createMockDiscovery({ vendor: 'claude' });
    const codexDiscovery = createMockDiscovery({ vendor: 'codex' });

    registerAdapter(claudeDiscovery, () => createMockAdapter({ vendor: 'claude' }));
    registerAdapter(codexDiscovery, () => createMockAdapter({ vendor: 'codex' }));

    const all = getDiscoveries();
    expect(all).toHaveLength(2);
    expect(all).toContain(claudeDiscovery);
    expect(all).toContain(codexDiscovery);
  });

  it('getDiscovery returns undefined for unregistered vendor', () => {
    expect(getDiscovery('gemini')).toBeUndefined();
  });
});

// ========== 2. Cross-Vendor Discovery ==========

describe('findSession', () => {
  it('finds session from the correct vendor', () => {
    const claudeSession = makeSessionInfo({ sessionId: 'sess-c1', vendor: 'claude' });
    const codexSession = makeSessionInfo({ sessionId: 'sess-x1', vendor: 'codex' });

    const claudeDiscovery = createMockDiscovery({ vendor: 'claude', sessions: [claudeSession] });
    const codexDiscovery = createMockDiscovery({ vendor: 'codex', sessions: [codexSession] });

    registerAdapter(claudeDiscovery, () => createMockAdapter({ vendor: 'claude' }));
    registerAdapter(codexDiscovery, () => createMockAdapter({ vendor: 'codex' }));

    const found = findSession('sess-x1');
    expect(found).toBeDefined();
    expect(found!.vendor).toBe('codex');
    expect(found!.sessionId).toBe('sess-x1');
  });

  it('returns undefined when no vendor claims the session', () => {
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    expect(findSession('nonexistent')).toBeUndefined();
  });

  it('iterates discoveries until one claims the session', () => {
    const claudeSession = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const claudeDiscovery = createMockDiscovery({ vendor: 'claude', sessions: [claudeSession] });
    const codexDiscovery = createMockDiscovery({ vendor: 'codex', sessions: [] });

    registerAdapter(codexDiscovery, () => createMockAdapter({ vendor: 'codex' }));
    registerAdapter(claudeDiscovery, () => createMockAdapter({ vendor: 'claude' }));

    const found = findSession('sess-1');
    expect(found).toBeDefined();
    expect(found!.vendor).toBe('claude');
    // codex discovery was called but returned undefined
    expect(codexDiscovery.findSession).toHaveBeenCalledWith('sess-1');
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

    const claudeDiscovery = createMockDiscovery({ vendor: 'claude', sessions: [s1, s3] });
    const codexDiscovery = createMockDiscovery({ vendor: 'codex', sessions: [s2] });

    registerAdapter(claudeDiscovery, () => createMockAdapter({ vendor: 'claude' }));
    registerAdapter(codexDiscovery, () => createMockAdapter({ vendor: 'codex' }));

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
  it('finds the vendor and delegates to discovery.loadHistory', async () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
    ];
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({
      vendor: 'claude',
      sessions: [session],
      historyEntries: entries,
    });

    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const result = await loadSession('sess-1');
    expect(result).toEqual(entries);
    expect(discovery.loadHistory).toHaveBeenCalledWith('sess-1');
  });

  it('returns empty array when session not found', async () => {
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const result = await loadSession('nonexistent');
    expect(result).toEqual([]);
  });

  it('does not create a channel (read-only)', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await loadSession('sess-1');

    // Sending to this session should throw because no channel was opened
    expect(() => sendToSession('sess-1', 'hello')).toThrow('No open channel');
  });
});

// ========== 3. subscribeSession ==========

describe('subscribeSession', () => {
  it('creates a channel, wires a factory adapter, backfills history, and subscribes', async () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
    ];
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({
      vendor: 'claude',
      sessions: [session],
      historyEntries: entries,
    });

    const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
    registerAdapter(discovery, factory);

    const sub = createTestSubscriber('sub-1');
    const channel = await subscribeSession('sess-1', sub);

    expect(channel).toBeDefined();
    expect(channel.channelId).toBe('sess-1');
    // Channel adapter is factory-created, not the discovery object
    expect(channel.adapter!.vendor).toBe('claude');

    // loadHistory was called on the discovery object
    expect(discovery.loadHistory).toHaveBeenCalledWith('sess-1');

    // The channel's entryIndex reflects the history
    expect(channel.entryIndex).toBe(2);

    // Subscriber is registered
    expect(channel.subscribers.has('sub-1')).toBe(true);

    // Channel transitioned to idle (from setAdapter)
    expect(channel.state).not.toBe('unattached');
  });

  it('reuses existing channel for second subscriber', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub1 = createTestSubscriber('sub-1');
    const channel1 = await subscribeSession('sess-1', sub1);

    const sub2 = createTestSubscriber('sub-2');
    const channel2 = await subscribeSession('sess-1', sub2);

    // Same channel reused
    expect(channel2).toBe(channel1);
    expect(channel2.subscribers.size).toBe(2);
  });

  it('throws when session not found across any vendor', async () => {
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub = createTestSubscriber('sub-1');
    await expect(subscribeSession('nonexistent', sub)).rejects.toThrow('not found');
  });
});

// ========== 4. Session-Keyed Live Operations ==========

describe('sendToSession', () => {
  it('delegates to the channel adapter send()', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
    registerAdapter(discovery, factory);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    sendToSession('sess-1', 'Hello world');
    expect(lastCreated().send).toHaveBeenCalledWith('Hello world', undefined);
  });

  it('throws when no channel is open', () => {
    expect(() => sendToSession('nonexistent', 'hello')).toThrow('No open channel');
  });
});

describe('setSessionModel', () => {
  it('delegates to adapter.setModel()', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
    registerAdapter(discovery, factory);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    await setSessionModel('sess-1', 'opus');
    expect(lastCreated().setModel).toHaveBeenCalledWith('opus');
  });

  it('throws when no channel is open', async () => {
    await expect(setSessionModel('nonexistent', 'opus')).rejects.toThrow('No open channel');
  });
});

describe('interruptSession', () => {
  it('delegates to adapter.interrupt()', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
    registerAdapter(discovery, factory);

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    await interruptSession('sess-1');
    expect(lastCreated().interrupt).toHaveBeenCalled();
  });

  it('throws when no channel is open', async () => {
    await expect(interruptSession('nonexistent')).rejects.toThrow('No open channel');
  });
});

describe('closeSession', () => {
  it('tears down channel and removes from registry', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub = createTestSubscriber('sub-1');
    const channel = await subscribeSession('sess-1', sub);

    closeSession('sess-1');

    // Channel is gone — operations should throw
    expect(() => sendToSession('sess-1', 'hello')).toThrow('No open channel');

    // No broadcast on teardown — channel is torn down (state set internally)
    expect(channel.state).toBe('unattached');
  });

  it('is no-op if no channel is open for sessionId', () => {
    expect(() => closeSession('nonexistent')).not.toThrow();
  });
});

describe('_resetRegistry', () => {
  it('clears all discoveries and sessions', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    _resetRegistry();

    expect(getDiscovery('claude')).toBeUndefined();
    expect(getDiscoveries()).toHaveLength(0);
    expect(() => sendToSession('sess-1', 'hello')).toThrow('No open channel');
  });
});

// ============================================================================
// B) Regression Tests
// ============================================================================

// ========== Per-session adapters: multiple live sessions ==========

describe('Regression: per-session adapters allow multiple live sessions', () => {
  it('multiple live sessions for the same vendor succeed', async () => {
    const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const s2 = makeSessionInfo({ sessionId: 'sess-2', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1, s2] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-2');

    const channel1 = await subscribeSession('sess-1', sub1);
    const channel2 = await subscribeSession('sess-2', sub2);

    expect(channel1).toBeDefined();
    expect(channel2).toBeDefined();
    expect(channel1.channelId).toBe('sess-1');
    expect(channel2.channelId).toBe('sess-2');
    // Each channel has its own adapter instance
    expect(channel1.adapter).not.toBe(channel2.adapter);
  });

  it('closing the first session does not affect the second', async () => {
    const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const s2 = makeSessionInfo({ sessionId: 'sess-2', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1, s2] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-2');

    await subscribeSession('sess-1', sub1);
    const channel2 = await subscribeSession('sess-2', sub2);

    // Close first session
    closeSession('sess-1');
    await tick();

    // Second session still alive
    expect(channel2.state).not.toBe('unattached');
    expect(() => sendToSession('sess-2', 'hi')).not.toThrow();
  });

  it('different vendors can have simultaneous live sessions', async () => {
    const claudeSession = makeSessionInfo({ sessionId: 'sess-c1', vendor: 'claude' });
    const codexSession = makeSessionInfo({ sessionId: 'sess-x1', vendor: 'codex' });

    const claudeDiscovery = createMockDiscovery({ vendor: 'claude', sessions: [claudeSession] });
    const codexDiscovery = createMockDiscovery({ vendor: 'codex', sessions: [codexSession] });

    registerAdapter(claudeDiscovery, () => createMockAdapter({ vendor: 'claude' }));
    registerAdapter(codexDiscovery, () => createMockAdapter({ vendor: 'codex' }));

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
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });

    // First call fails, second succeeds — on the discovery's loadHistory
    (discovery.loadHistory as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Disk read failed'))
      .mockResolvedValueOnce([
        { type: 'user', message: { role: 'user', content: 'hello' } },
      ]);

    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub1 = createTestSubscriber('sub-1');

    // First call should fail
    await expect(subscribeSession('sess-1', sub1)).rejects.toThrow('Disk read failed');

    // The poisoned channel should have been cleaned up, so a retry should work
    const sub2 = createTestSubscriber('sub-2');
    const channel = await subscribeSession('sess-1', sub2);
    expect(channel).toBeDefined();
    expect(channel.channelId).toBe('sess-1');

    // loadHistory was called twice (once per attempt)
    expect(discovery.loadHistory).toHaveBeenCalledTimes(2);

    // The subscriber is registered on the fresh channel
    expect(channel.subscribers.has('sub-2')).toBe(true);
  });
});

// ========== Bug 3: Terminal/dead channel eviction ==========

describe('Regression: terminal/dead channel eviction', () => {
  it('evicts unattached channel and creates a fresh one', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });

    const created: MockAdapter[] = [];
    const factory = () => {
      const adapter = createMockAdapter({ vendor: 'claude' });
      created.push(adapter);
      return adapter;
    };

    registerAdapter(discovery, factory);

    // Open session and get channel
    const sub1 = createTestSubscriber('sub-1');
    const channel1 = await subscribeSession('sess-1', sub1);

    // Simulate stream exhaustion -> channel goes to 'unattached'
    created[0].completeStream();
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
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub = createTestSubscriber('sub-1');
    const channel = await subscribeSession('sess-1', sub);

    // Verify channel is live
    expect(() => sendToSession('sess-1', 'hi')).not.toThrow();

    // Unregister the vendor
    unregisterAdapter('claude');

    // Channel should be torn down
    expect(() => sendToSession('sess-1', 'hello')).toThrow('No open channel');

    // Discovery should be gone
    expect(getDiscovery('claude')).toBeUndefined();

    // Channel state is unattached (no broadcast on teardown)
    expect(channel.state).toBe('unattached');
  });

  it('unregistering vendor does not affect other vendors', async () => {
    const claudeSession = makeSessionInfo({ sessionId: 'sess-c1', vendor: 'claude' });
    const codexSession = makeSessionInfo({ sessionId: 'sess-x1', vendor: 'codex' });

    const claudeDiscovery = createMockDiscovery({ vendor: 'claude', sessions: [claudeSession] });
    const codexDiscovery = createMockDiscovery({ vendor: 'codex', sessions: [codexSession] });

    registerAdapter(claudeDiscovery, () => createMockAdapter({ vendor: 'claude' }));
    registerAdapter(codexDiscovery, () => createMockAdapter({ vendor: 'codex' }));

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

    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    // Use a slow loadHistory on the discovery to create a window for concurrency
    (discovery.loadHistory as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<TranscriptEntry[]>((resolve) => setTimeout(() => resolve(entries), 50)),
    );

    let factoryCallCount = 0;
    const factory = (_sessionId: string) => {
      factoryCallCount++;
      return createMockAdapter({ vendor: 'claude' });
    };
    registerAdapter(discovery, factory);

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

    // Factory was called only once (coalesced)
    expect(factoryCallCount).toBe(1);

    // loadHistory was called only once
    expect(discovery.loadHistory).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls share a single channel initialization', async () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
    ];
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });

    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    (discovery.loadHistory as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<TranscriptEntry[]>((resolve) => setTimeout(() => resolve(entries), 20)),
    );
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub1 = createTestSubscriber('sub-1');
    const sub2 = createTestSubscriber('sub-2');

    const [ch1, ch2] = await Promise.all([
      subscribeSession('sess-1', sub1),
      subscribeSession('sess-1', sub2),
    ]);

    // Both got the same channel
    expect(ch1).toBe(ch2);

    // loadHistory was called only once (coalesced)
    expect(discovery.loadHistory).toHaveBeenCalledTimes(1);

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

    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    (discovery.loadHistory as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<TranscriptEntry[]>((_, reject) =>
        setTimeout(() => reject(new Error('Boom')), 20),
      ),
    );
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

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
