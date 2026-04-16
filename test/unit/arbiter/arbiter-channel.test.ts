/**
 * Arbiter Channel Integration Test — channel-level interception
 *
 * Verifies that broadcastAndTrack() auto-resolves tool call approval events
 * when an arbiterPolicy is set on the channel. Tests the three paths:
 * - allow: resolveApproval('allow') called, no broadcast to subscribers
 * - deny: resolveApproval('deny') called, no broadcast to subscribers
 * - escalate: event reaches subscribers normally
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChannelMessage } from '../../../src/core/agent-adapter.js';
import type { ArbiterPolicy } from '../../../src/core/arbiter/types.js';
import type { Subscriber } from '../../../src/core/session-channel.js';
import {
  createChannel,
  setAdapter,
  subscribe,
  destroyChannel,
  _resetRegistry,
} from '../../../src/core/session-channel.js';

// ── Mock Adapter ────────────────────────────────────────────────────────

/** Minimal AgentAdapter mock that yields pre-loaded messages via AsyncIterableQueue pattern. */
function createMockAdapter(messages: ChannelMessage[]) {
  let approvals: Array<{ toolUseId: string; optionId: string; extra?: unknown }> = [];

  const adapter = {
    vendor: 'claude' as const,
    sessionId: 'test-session',
    settings: {},
    contextUsage: null,
    inputCollector: null,
    sendTurn: vi.fn(),
    respondToApproval: vi.fn((toolUseId: string, optionId: string, extra?: unknown) => {
      approvals.push({ toolUseId, optionId, extra });
    }),
    interrupt: vi.fn(),
    close: vi.fn(),
    async *messages(): AsyncIterableIterator<ChannelMessage> {
      for (const msg of messages) {
        yield msg;
      }
    },
    getApprovals: () => approvals,
  };

  return adapter;
}

// ── Test Policy ─────────────────────────────────────────────────────────

const TEST_POLICY: ArbiterPolicy = {
  deny: ['Write', 'Edit', 'Bash(rm *)'],
  allow: ['Read(*)', 'Grep(*)', 'Bash(git status)'],
  fallback: 'escalate',
  bashMode: 'strict',
};

// ── Helpers ─────────────────────────────────────────────────────────────

function approvalEvent(toolName: string, input: unknown, toolUseId: string): ChannelMessage {
  return {
    type: 'event',
    event: {
      type: 'status',
      status: 'awaiting_approval',
      toolUseId,
      toolName,
      input,
      options: [
        { id: 'allow', label: 'Allow', isAllowed: true },
        { id: 'deny', label: 'Deny', isAllowed: true },
      ],
    },
  };
}

function activeEvent(): ChannelMessage {
  return { type: 'event', event: { type: 'status', status: 'active' } };
}

function idleEvent(): ChannelMessage {
  return { type: 'event', event: { type: 'status', status: 'idle' } };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Arbiter Channel Interception', () => {
  beforeEach(() => {
    _resetRegistry();
  });

  afterEach(() => {
    _resetRegistry();
  });

  test('allow: auto-resolves and skips broadcast', async () => {
    const messages: ChannelMessage[] = [
      activeEvent(),
      approvalEvent('Read', { file_path: '/foo/bar.ts' }, 'tool-1'),
      // After resolve, adapter emits active then idle
      activeEvent(),
      idleEvent(),
    ];

    const adapter = createMockAdapter(messages);
    const received: ChannelMessage[] = [];
    const sub: Subscriber = { id: 'test-sub', send: (msg) => { if (msg.type !== 'catchup') received.push(msg as ChannelMessage); } };

    const channel = createChannel('test-allow');
    channel.arbiterPolicy = TEST_POLICY;
    subscribe(channel, sub, { skipCatchup: true });
    setAdapter(channel, adapter as any);

    // Wait for consumption loop to drain
    await channel.loopDone;

    // The approval event should NOT have been broadcast to subscribers
    const approvalEvents = received.filter(
      (m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'awaiting_approval',
    );
    expect(approvalEvents).toHaveLength(0);

    // Adapter should have been called with 'allow'
    expect(adapter.respondToApproval).toHaveBeenCalledWith('tool-1', 'allow', undefined);

    // active and idle events should still be broadcast
    const statusEvents = received.filter((m) => m.type === 'event' && m.event.type === 'status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
  });

  test('deny: auto-resolves with deny message and skips broadcast', async () => {
    const messages: ChannelMessage[] = [
      activeEvent(),
      approvalEvent('Write', { file_path: '/foo/bar.ts', content: 'evil' }, 'tool-2'),
      activeEvent(),
      idleEvent(),
    ];

    const adapter = createMockAdapter(messages);
    const received: ChannelMessage[] = [];
    const sub: Subscriber = { id: 'test-sub', send: (msg) => { if (msg.type !== 'catchup') received.push(msg as ChannelMessage); } };

    const channel = createChannel('test-deny');
    channel.arbiterPolicy = TEST_POLICY;
    subscribe(channel, sub, { skipCatchup: true });
    setAdapter(channel, adapter as any);

    await channel.loopDone;

    // The approval event should NOT have been broadcast
    const approvalEvents = received.filter(
      (m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'awaiting_approval',
    );
    expect(approvalEvents).toHaveLength(0);

    // Adapter should have been called with 'deny' and a message
    expect(adapter.respondToApproval).toHaveBeenCalledWith(
      'tool-2',
      'deny',
      expect.objectContaining({ message: expect.stringContaining('Denied by arbiter') }),
    );
  });

  test('escalate: approval event reaches subscribers normally', async () => {
    // 'Agent' is not in allow list and fallback is 'escalate' → escalates
    // Actually 'Agent' is not in deny list either... Let me use something not in any list
    const messages: ChannelMessage[] = [
      activeEvent(),
      // TodoWrite — not in deny or allow, fallback = escalate
      approvalEvent('TodoWrite', { todos: [] }, 'tool-3'),
      idleEvent(),
    ];

    const adapter = createMockAdapter(messages);
    const received: ChannelMessage[] = [];
    const sub: Subscriber = { id: 'test-sub', send: (msg) => { if (msg.type !== 'catchup') received.push(msg as ChannelMessage); } };

    const channel = createChannel('test-escalate');
    channel.arbiterPolicy = TEST_POLICY;
    subscribe(channel, sub, { skipCatchup: true });
    setAdapter(channel, adapter as any);

    await channel.loopDone;

    // The approval event SHOULD have been broadcast (escalated to human)
    const approvalEvents = received.filter(
      (m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'awaiting_approval',
    );
    expect(approvalEvents).toHaveLength(1);

    // respondToApproval should NOT have been called
    expect(adapter.respondToApproval).not.toHaveBeenCalled();
  });

  test('no policy: approval events pass through normally', async () => {
    const messages: ChannelMessage[] = [
      activeEvent(),
      approvalEvent('Write', { file_path: '/foo.ts', content: 'x' }, 'tool-4'),
      idleEvent(),
    ];

    const adapter = createMockAdapter(messages);
    const received: ChannelMessage[] = [];
    const sub: Subscriber = { id: 'test-sub', send: (msg) => { if (msg.type !== 'catchup') received.push(msg as ChannelMessage); } };

    const channel = createChannel('test-no-policy');
    // No arbiterPolicy set
    subscribe(channel, sub, { skipCatchup: true });
    setAdapter(channel, adapter as any);

    await channel.loopDone;

    // Approval event should reach subscriber
    const approvalEvents = received.filter(
      (m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'awaiting_approval',
    );
    expect(approvalEvents).toHaveLength(1);

    // respondToApproval should NOT have been called by arbiter
    expect(adapter.respondToApproval).not.toHaveBeenCalled();
  });

  test('bash strict mode: compound commands denied', async () => {
    const messages: ChannelMessage[] = [
      activeEvent(),
      approvalEvent('Bash', { command: 'echo hello && rm -rf /' }, 'tool-5'),
      activeEvent(),
      idleEvent(),
    ];

    const adapter = createMockAdapter(messages);
    const received: ChannelMessage[] = [];
    const sub: Subscriber = { id: 'test-sub', send: (msg) => { if (msg.type !== 'catchup') received.push(msg as ChannelMessage); } };

    const channel = createChannel('test-bash-strict');
    channel.arbiterPolicy = TEST_POLICY;
    subscribe(channel, sub, { skipCatchup: true });
    setAdapter(channel, adapter as any);

    await channel.loopDone;

    // Compound command should be denied by bash strict mode
    expect(adapter.respondToApproval).toHaveBeenCalledWith(
      'tool-5',
      'deny',
      expect.objectContaining({ message: expect.stringContaining('Denied by arbiter') }),
    );

    // Should not reach subscribers
    const approvalEvents = received.filter(
      (m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'awaiting_approval',
    );
    expect(approvalEvents).toHaveLength(0);
  });
});
