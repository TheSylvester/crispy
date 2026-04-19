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
import type { AgentAdapter, AdapterSettings, SessionInfo, ChannelMessage, VendorDiscovery, TurnSettings } from '../src/core/agent-adapter.js';
import type { TranscriptEntry, MessageContent, Vendor } from '../src/core/transcript.js';
import type { ChannelStatus } from '../src/core/channel-events.js';
import type { Subscriber, SubscriberMessage } from '../src/core/session-channel.js';

import {
  _resetRegistry as _resetChannelRegistry,
  getChannel,
} from '../src/core/session-channel.js';

import {
  registerAdapter,
  unregisterAdapter,
  getDiscovery,
  getDiscoveries,
  findSession,
  resolveSessionPrefix,
  loadSession,
  listAllSessions,
  listOpenChannels,
  registerChildSession,
  subscribeSession,
  interruptSession,
  closeSession,
  _resetRegistry,
} from '../src/core/session-manager.js';
import { _setTestDir, setSessionKind } from '../src/core/activity-index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

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

  const sendTurnMock = vi.fn((_content: MessageContent, _settings: TurnSettings) => {});

  return {
    vendor,
    get sessionId() { return sessionId; },
    get status() { return status; },
    get contextUsage() { return null; },
    get settings(): AdapterSettings {
      return { vendor, model: undefined, permissionMode: undefined, allowDangerouslySkipPermissions: false, extraArgs: undefined };
    },
    outputQueue: queue,

    messages(): AsyncIterable<ChannelMessage> {
      return queue;
    },

    sendTurn: sendTurnMock as unknown as AgentAdapter['sendTurn'],

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
    factory: (_spec: unknown) => {
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

// ========== 2b. Session ID Prefix Resolution ==========

describe('resolveSessionPrefix', () => {
  const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
  const UUID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
  const UUID_A2 = 'aaaaaaaa-5555-6666-7777-888888888888';

  it('passes through full-length UUIDs unchanged', () => {
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    expect(resolveSessionPrefix(UUID_A)).toBe(UUID_A);
  });

  it('passes through empty string unchanged', () => {
    expect(resolveSessionPrefix('')).toBe('');
  });

  it('resolves a unique prefix to the full session ID', () => {
    const sessionA = makeSessionInfo({ sessionId: UUID_A, vendor: 'claude' });
    const sessionB = makeSessionInfo({ sessionId: UUID_B, vendor: 'codex' });

    const claudeDiscovery = createMockDiscovery({ vendor: 'claude', sessions: [sessionA] });
    const codexDiscovery = createMockDiscovery({ vendor: 'codex', sessions: [sessionB] });

    registerAdapter(claudeDiscovery, () => createMockAdapter({ vendor: 'claude' }));
    registerAdapter(codexDiscovery, () => createMockAdapter({ vendor: 'codex' }));

    expect(resolveSessionPrefix('aaaaaaaa')).toBe(UUID_A);
    expect(resolveSessionPrefix('bbbbbbbb')).toBe(UUID_B);
  });

  it('throws on ambiguous prefix with matching IDs listed', () => {
    const sessionA = makeSessionInfo({ sessionId: UUID_A, vendor: 'claude' });
    const sessionA2 = makeSessionInfo({ sessionId: UUID_A2, vendor: 'claude' });

    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [sessionA, sessionA2] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    expect(() => resolveSessionPrefix('aaaaaaaa')).toThrow('Ambiguous');
    expect(() => resolveSessionPrefix('aaaaaaaa')).toThrow(UUID_A);
    expect(() => resolveSessionPrefix('aaaaaaaa')).toThrow(UUID_A2);
  });

  it('returns input unchanged when no sessions match the prefix', () => {
    const sessionA = makeSessionInfo({ sessionId: UUID_A, vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [sessionA] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    expect(resolveSessionPrefix('zzzzzzzz')).toBe('zzzzzzzz');
  });

  it('findSession uses prefix resolution transparently', () => {
    const sessionA = makeSessionInfo({ sessionId: UUID_A, vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [sessionA] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const found = findSession('aaaaaaaa');
    expect(found).toBeDefined();
    expect(found!.sessionId).toBe(UUID_A);
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

    // No channel was opened — loadSession is read-only
    expect(getChannel('sess-1')).toBeUndefined();
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

    // Channel is gone
    expect(getChannel('sess-1')).toBeUndefined();

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
    expect(getChannel('sess-1')).toBeUndefined();
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
    expect(channel2.adapter).not.toBeNull();
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
    expect(getChannel('sess-1')).toBeDefined();

    // Unregister the vendor
    unregisterAdapter('claude');

    // Channel should be torn down
    expect(getChannel('sess-1')).toBeUndefined();

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
    expect(getChannel('sess-c1')).toBeUndefined();

    // Codex session is still alive
    expect(getChannel('sess-x1')).not.toBeUndefined();
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
    const factory = (_spec: unknown) => {
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

    // loadHistory is called once during channel init. The second subscriber
    // gets entries from channel-owned entry list via catchup (no disk re-read).
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

    // loadHistory is called once during init. The second subscriber gets
    // entries from the channel-owned entry list via catchup (no disk re-read).
    expect(discovery.loadHistory).toHaveBeenCalledTimes(1);

    // The channel's entryIndex reflects the seeded history
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

// ============================================================================
// listOpenChannels
// ============================================================================

describe('listOpenChannels', () => {
  let testDir: string;
  let cleanupDir: () => void;

  beforeEach(() => {
    testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-list-open-'));
    cleanupDir = _setTestDir(testDir);
  });

  afterEach(() => {
    cleanupDir();
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('returns empty array when no channels are open', () => {
    expect(listOpenChannels()).toEqual([]);
  });

  it('returns one entry per open channel with correct shape', async () => {
    const session = makeSessionInfo({
      sessionId: 'sess-1',
      vendor: 'claude',
      projectPath: '/tmp/project',
    });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    const sub = createTestSubscriber('sub-1');
    await subscribeSession('sess-1', sub);

    const result = listOpenChannels();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sessionId: 'sess-1',
      vendor: 'claude',
      projectPath: '/tmp/project',
      pendingApprovalCount: 0,
      entryCount: 0,
    });
    expect(result[0].state).not.toBe('unattached');
    expect(result[0].sessionKind).toBeUndefined();
    expect(result[0].isSidechain).toBeUndefined();
    expect(result[0].parentSessionId).toBeUndefined();
  });

  it('sorts results by sessionId ascending', async () => {
    const sZ = makeSessionInfo({ sessionId: 'sess-zzz', vendor: 'claude' });
    const sA = makeSessionInfo({ sessionId: 'sess-aaa', vendor: 'claude' });
    const sM = makeSessionInfo({ sessionId: 'sess-mmm', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [sZ, sA, sM] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    // Subscribe in a non-sorted order to exercise Map insertion shuffle.
    await subscribeSession('sess-zzz', createTestSubscriber('sub-z'));
    await subscribeSession('sess-mmm', createTestSubscriber('sub-m'));
    await subscribeSession('sess-aaa', createTestSubscriber('sub-a'));

    const ids = listOpenChannels().map((r) => r.sessionId);
    expect(ids).toEqual(['sess-aaa', 'sess-mmm', 'sess-zzz']);
  });

  it('reflects accumulated entryCount from the channel', async () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', content: 'hello' } },
    ];
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({
      vendor: 'claude',
      sessions: [session],
      historyEntries: entries,
    });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-1', createTestSubscriber('sub-1'));

    const [info] = listOpenChannels();
    expect(info.entryCount).toBe(2);
  });

  it('filters out channels in unattached state (tombstone)', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-1', createTestSubscriber('sub-1'));
    const channel = getChannel('sess-1')!;
    channel.state = 'unattached';

    expect(listOpenChannels()).toEqual([]);
  });

  it('filters out channels with tearing=true (teardown in flight)', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-1', createTestSubscriber('sub-1'));
    const channel = getChannel('sess-1')!;
    channel.tearing = true;

    expect(listOpenChannels()).toEqual([]);
  });

  it('surfaces vendor: "unknown" mid-rotation when adapter is transiently null', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-1', createTestSubscriber('sub-1'));
    const channel = getChannel('sess-1')!;
    // Simulate rotateAdapter's mid-rotation state: adapter null but state still idle.
    channel.adapter = null;
    channel.state = 'idle';

    const result = listOpenChannels();
    expect(result).toHaveLength(1);
    expect(result[0].vendor).toBe('unknown');
  });

  it('populates child metadata when session is registered as a child', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-child', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-child', createTestSubscriber('sub-1'));
    registerChildSession('sess-child', {
      parentSessionId: 'sess-parent',
      autoClose: true,
      visible: false,
    });

    const [info] = listOpenChannels();
    expect(info.parentSessionId).toBe('sess-parent');
    expect(info.childAutoClose).toBe(true);
    expect(info.childVisible).toBe(false);
  });

  it('omits child metadata when parentSessionId is a pending: ID that never resolved', async () => {
    // Reproduces browser-qa finding: sessions dispatched from a pending-only
    // caller (e.g. crispy-dispatch CLI) register with a pending parent; that
    // string shouldn't leak into caller-visible output.
    const session = makeSessionInfo({ sessionId: 'sess-child', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-child', createTestSubscriber('sub-1'));
    registerChildSession('sess-child', {
      parentSessionId: 'pending:abc-123',
      autoClose: true,
      visible: true,
    });

    const [info] = listOpenChannels();
    expect(info.parentSessionId).toBeUndefined();
    expect(info.childAutoClose).toBeUndefined();
    expect(info.childVisible).toBeUndefined();
  });

  it('omits child metadata when parentSessionId is an empty string', async () => {
    const session = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-1', createTestSubscriber('sub-1'));
    // resumeChildSession defensively inserts '' for parentSessionId; we normalize to undefined.
    registerChildSession('sess-1', {
      parentSessionId: '',
      autoClose: false,
      visible: true,
    });

    const [info] = listOpenChannels();
    expect(info.parentSessionId).toBeUndefined();
    expect(info.childAutoClose).toBeUndefined();
    expect(info.childVisible).toBeUndefined();
  });

  it('filters system sessions by default and includes them with includeSystem: true', async () => {
    const sessionA = makeSessionInfo({ sessionId: 'sess-user', vendor: 'claude' });
    const sessionB = makeSessionInfo({ sessionId: 'sess-sys', vendor: 'claude' });
    const discovery = createMockDiscovery({
      vendor: 'claude',
      sessions: [sessionA, sessionB],
    });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-user', createTestSubscriber('sub-u'));
    await subscribeSession('sess-sys', createTestSubscriber('sub-s'));
    setSessionKind('sess-sys', 'system');

    // Default: system filtered out.
    const defaultResult = listOpenChannels();
    expect(defaultResult.map((r) => r.sessionId)).toEqual(['sess-user']);

    // Opt-in: system included with sessionKind flag.
    const fullResult = listOpenChannels({ includeSystem: true });
    expect(fullResult.map((r) => r.sessionId)).toEqual(['sess-sys', 'sess-user']);
    const sys = fullResult.find((r) => r.sessionId === 'sess-sys')!;
    expect(sys.sessionKind).toBe('system');
    const user = fullResult.find((r) => r.sessionId === 'sess-user')!;
    expect(user.sessionKind).toBeUndefined();
  });

  it('filters sidechains by default and includes them with includeSidechains: true', async () => {
    const sessionA = makeSessionInfo({ sessionId: 'sess-main', vendor: 'claude' });
    const sessionB = makeSessionInfo({
      sessionId: 'sess-side',
      vendor: 'claude',
      isSidechain: true,
    });
    const discovery = createMockDiscovery({
      vendor: 'claude',
      sessions: [sessionA, sessionB],
    });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-main', createTestSubscriber('sub-m'));
    await subscribeSession('sess-side', createTestSubscriber('sub-s'));

    const defaultResult = listOpenChannels();
    expect(defaultResult.map((r) => r.sessionId)).toEqual(['sess-main']);

    const fullResult = listOpenChannels({ includeSidechains: true });
    expect(fullResult.map((r) => r.sessionId)).toEqual(['sess-main', 'sess-side']);
    const side = fullResult.find((r) => r.sessionId === 'sess-side')!;
    expect(side.isSidechain).toBe(true);
  });

  it('documents the pending-ID leak: caller-supplied non-"pending:" temp IDs pass through', async () => {
    // The invariant-leak case from the plan: createPendingChannel accepts
    // an `explicitPendingId` and sendTurn accepts a caller-supplied
    // `pendingId`. A malformed ID that does not startsWith('pending:')
    // passes through the filter and appears in the result.
    const session = makeSessionInfo({ sessionId: 'not-a-pending-id', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('not-a-pending-id', createTestSubscriber('sub-1'));

    const result = listOpenChannels();
    // Documented behavior: non-"pending:" IDs leak through the convention-based filter.
    expect(result.map((r) => r.sessionId)).toContain('not-a-pending-id');
  });

  it('documents the sidechain-race caveat: a live sidechain passes the filter if disk index has not caught up', async () => {
    // Scenario: channel exists in sessions Map, but discovery.findSession
    // returns undefined (not yet indexed). Default sidechain filter sees no
    // isSidechain signal, so the session passes through.
    const session = makeSessionInfo({ sessionId: 'sess-unindexed', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [session] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-unindexed', createTestSubscriber('sub-1'));

    // Simulate the race: after subscribe, disk index "loses" the entry.
    (discovery.findSession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (discovery.listSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const result = listOpenChannels();
    // Documented behavior: with no isSidechain signal from disk, the
    // session passes the default filter. Callers needing a guarantee
    // should use includeSidechains + client-side provenance checks.
    expect(result.map((r) => r.sessionId)).toContain('sess-unindexed');
    expect(result[0].isSidechain).toBeUndefined();
  });

  it('reflects post-close state consistently after a prior closeSession', async () => {
    const sA = makeSessionInfo({ sessionId: 'sess-a', vendor: 'claude' });
    const sB = makeSessionInfo({ sessionId: 'sess-b', vendor: 'claude' });
    const discovery = createMockDiscovery({ vendor: 'claude', sessions: [sA, sB] });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    await subscribeSession('sess-a', createTestSubscriber('sub-a'));
    await subscribeSession('sess-b', createTestSubscriber('sub-b'));

    closeSession('sess-a');

    expect(() => listOpenChannels()).not.toThrow();
    const result = listOpenChannels();
    expect(result.map((r) => r.sessionId)).toEqual(['sess-b']);
  });

  it('does not throw when the sessions-map key is a prefix of multiple disk sessions', async () => {
    // Regression: the pending-bypass path lets callers register a channel
    // under a short non-'pending:' key. Calling the public findSession(id)
    // during enrichment would route through resolveSessionPrefix, which
    // scans listAllSessions() and throws "Ambiguous session prefix" when
    // 2+ disk sessions share the key's prefix. listOpenChannels must
    // enrich via direct per-adapter lookup instead.
    const shortKey = 'abc';
    const liveSession = makeSessionInfo({ sessionId: shortKey, vendor: 'claude' });
    const discovery = createMockDiscovery({
      vendor: 'claude',
      sessions: [liveSession],
    });
    registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

    // Initial subscribe: only `liveSession` exists, so the prefix 'abc'
    // resolves uniquely and subscribe succeeds with sessions.set('abc').
    await subscribeSession(shortKey, createTestSubscriber('sub-1'));

    // Now the disk grows: two more sessions also start with 'abc'. Any
    // call through the public findSession(shortKey) from this point on
    // would throw "Ambiguous session prefix".
    (discovery.listSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      liveSession,
      makeSessionInfo({
        sessionId: 'abc11111-1111-1111-1111-111111111111',
        vendor: 'claude',
      }),
      makeSessionInfo({
        sessionId: 'abc22222-2222-2222-2222-222222222222',
        vendor: 'claude',
      }),
    ]);
    // Invalidate listAllSessions()'s 5-second cache by registering a
    // second vendor adapter (side-effect: calls invalidateSessionCache).
    registerAdapter(
      createMockDiscovery({ vendor: 'codex', sessions: [] }),
      () => createMockAdapter({ vendor: 'codex' }),
    );

    // Listing must not throw despite the now-ambiguous prefix — this is
    // the blocker the fix addresses.
    expect(() => listOpenChannels()).not.toThrow();
    const result = listOpenChannels();
    expect(result.map((r) => r.sessionId)).toContain(shortKey);
  });
});
