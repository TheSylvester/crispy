/**
 * Tests for awaitChannelIdle() — the shared wait-for-idle helper that
 * backs the four in-tree call sites and the public `waitForIdle` RPC.
 *
 * Strategy: drive a real `SessionChannel` through `setAdapter` and a
 * mock adapter that pushes `ChannelMessage`s through the consumption
 * loop. Assert the helper resolves with the expected reason.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncIterableQueue } from '../src/core/async-iterable-queue.js';
import type { AgentAdapter, AdapterSettings, ChannelMessage, TurnSettings } from '../src/core/agent-adapter.js';
import type { MessageContent, Vendor } from '../src/core/transcript.js';
import {
  createChannel,
  destroyChannel,
  _resetRegistry,
  setAdapter,
} from '../src/core/session-channel.js';
import { awaitChannelIdle } from '../src/core/session-manager.js';

// ============================================================================
// Mock Adapter — same shape as session-channel.test.ts but minimal.
// ============================================================================

interface MockAdapter extends AgentAdapter {
  pushMessage(msg: ChannelMessage): void;
  completeStream(): void;
}

function createMockAdapter(options?: { vendor?: Vendor; sessionId?: string }): MockAdapter {
  const queue = new AsyncIterableQueue<ChannelMessage>();
  const vendor = options?.vendor ?? 'claude';
  const sessionId = options?.sessionId ?? 'session-test';

  return {
    vendor,
    get sessionId() { return sessionId; },
    get status() { return 'idle' as const; },
    get contextUsage() { return null; },
    get settings(): AdapterSettings {
      return { vendor, model: undefined, permissionMode: undefined, allowDangerouslySkipPermissions: false, extraArgs: undefined };
    },
    messages(): AsyncIterable<ChannelMessage> { return queue; },
    sendTurn: vi.fn((_content: MessageContent, _settings: TurnSettings) => {}) as unknown as AgentAdapter['sendTurn'],
    respondToApproval: vi.fn(() => {}),
    close: vi.fn(() => { queue.done(); }),
    interrupt: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    pushMessage(msg: ChannelMessage): void { queue.enqueue(msg); },
    completeStream(): void { queue.done(); },
  };
}

const idleEvent = (turnComplete?: true): ChannelMessage => ({
  type: 'event',
  event: { type: 'status', status: 'idle', ...(turnComplete && { turnComplete }) },
});
const backgroundEvent = (turnComplete?: true): ChannelMessage => ({
  type: 'event',
  event: { type: 'status', status: 'background', ...(turnComplete && { turnComplete }) },
});
const activeEvent: ChannelMessage = {
  type: 'event',
  event: { type: 'status', status: 'active' },
};
const approvalEvent: ChannelMessage = {
  type: 'event',
  event: {
    type: 'status',
    status: 'awaiting_approval',
    toolUseId: 'tool-1',
    toolName: 'Bash',
    input: { command: 'ls' },
    options: [{ id: 'allow', label: 'Allow' }],
  },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { _resetRegistry(); });
afterEach(() => {
  _resetRegistry();
  vi.useRealTimers();
});

// ============================================================================
// 1. Authoritative idle — turnComplete:true resolves immediately.
// ============================================================================

describe('awaitChannelIdle — authoritative idle', () => {
  it('resolves immediately with turnComplete on idle:turnComplete', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await tick();

    // Move to streaming so grace window doesn't fast-path.
    adapter.pushMessage(activeEvent);
    await tick();
    expect(ch.state).toBe('streaming');

    const promise = awaitChannelIdle(ch);
    adapter.pushMessage(idleEvent(true));
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });
});

// ============================================================================
// 2. Debounced idle — non-authoritative idle settles after IDLE_SETTLE_MS.
// ============================================================================

describe('awaitChannelIdle — debounced idle', () => {
  it('resolves with settled after the 2000ms debounce window', async () => {
    vi.useFakeTimers();
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await vi.advanceTimersByTimeAsync(0);

    adapter.pushMessage(activeEvent);
    await vi.advanceTimersByTimeAsync(0);

    const promise = awaitChannelIdle(ch);
    adapter.pushMessage(idleEvent());
    await vi.advanceTimersByTimeAsync(0);

    let resolved = false;
    promise.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(1500);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(700); // total > 2000
    const reason = await promise;
    expect(reason).toBe('settled');
    destroyChannel('ch-1');
  });

  it('status:active during debounce cancels the timer', async () => {
    vi.useFakeTimers();
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await vi.advanceTimersByTimeAsync(0);

    adapter.pushMessage(activeEvent);
    await vi.advanceTimersByTimeAsync(0);

    const promise = awaitChannelIdle(ch);
    adapter.pushMessage(idleEvent());
    await vi.advanceTimersByTimeAsync(0);

    // Cancel debounce mid-window with another active event.
    await vi.advanceTimersByTimeAsync(1000);
    adapter.pushMessage(activeEvent);
    await vi.advanceTimersByTimeAsync(0);

    let resolved = false;
    promise.then(() => { resolved = true; });
    // Past where debounce would have fired — should not resolve.
    await vi.advanceTimersByTimeAsync(2500);
    expect(resolved).toBe(false);

    // Push another idle (no turnComplete) to re-arm; wait full debounce.
    adapter.pushMessage(idleEvent());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2100);
    const reason = await promise;
    expect(reason).toBe('settled');
    destroyChannel('ch-1');
  });
});

// ============================================================================
// 3. Timeout.
// ============================================================================

describe('awaitChannelIdle — timeout', () => {
  it('resolves with timeout when no idle within timeoutMs', async () => {
    vi.useFakeTimers();
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await vi.advanceTimersByTimeAsync(0);

    // Move out of idle so grace window doesn't fire first.
    adapter.pushMessage(activeEvent);
    await vi.advanceTimersByTimeAsync(0);

    const promise = awaitChannelIdle(ch, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    const reason = await promise;
    expect(reason).toBe('timeout');
    destroyChannel('ch-1');
  });
});

// ============================================================================
// 4. onMessage interrupt.
// ============================================================================

describe('awaitChannelIdle — onMessage interrupt', () => {
  it('resolves with interrupted when onMessage returns "interrupt"', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(activeEvent);
    await tick();

    const promise = awaitChannelIdle(ch, {
      onMessage: (msg) => {
        if (msg.type === 'event' && msg.event.type === 'status' && msg.event.status === 'awaiting_approval') {
          return 'interrupt';
        }
      },
    });
    adapter.pushMessage(approvalEvent);
    const reason = await promise;
    expect(reason).toBe('interrupted');
    destroyChannel('ch-1');
  });
});

// ============================================================================
// 5. deferUntil.
// ============================================================================

describe('awaitChannelIdle — deferUntil', () => {
  it('blocks resolution until both idle and deferUntil settle', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(activeEvent);
    await tick();

    let resolveDefer!: () => void;
    const defer = new Promise<void>((resolve) => { resolveDefer = resolve; });

    const promise = awaitChannelIdle(ch, { deferUntil: defer });
    adapter.pushMessage(idleEvent(true));
    await tick();

    let resolved = false;
    promise.then(() => { resolved = true; });
    await tick();
    expect(resolved).toBe(false);

    resolveDefer();
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });
});

// ============================================================================
// 6. Already-idle entry — grace window cases.
// ============================================================================

describe('awaitChannelIdle — already-idle grace window', () => {
  it('resolves "settled" after the 500ms grace when channel enters idle', async () => {
    vi.useFakeTimers();
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(ch.state).toBe('idle');
    expect(ch.pendingApprovals.size).toBe(0);

    const promise = awaitChannelIdle(ch);

    let resolved = false;
    promise.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(450);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(100); // total 550
    const reason = await promise;
    expect(reason).toBe('settled');
    destroyChannel('ch-1');
  });

  it('grace cancelled by status:active mid-window', async () => {
    vi.useFakeTimers();
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(ch.state).toBe('idle');

    const promise = awaitChannelIdle(ch);

    // At t=100ms, fire active.
    await vi.advanceTimersByTimeAsync(100);
    adapter.pushMessage(activeEvent);
    await vi.advanceTimersByTimeAsync(0);

    let resolved = false;
    promise.then(() => { resolved = true; });

    // Fast-forward past the original 500ms grace deadline — must not resolve.
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    // Now drive a real idle:turnComplete to release.
    adapter.pushMessage(idleEvent(true));
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });

  it('does NOT enter grace when channel has pending approvals', async () => {
    vi.useFakeTimers();
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await vi.advanceTimersByTimeAsync(0);

    // Inject a pending approval first (state becomes awaiting_approval).
    adapter.pushMessage(approvalEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(ch.pendingApprovals.size).toBe(1);

    // Force state back to 'idle' for the entry-state check while leaving
    // pendingApprovals populated — this isolates the pendingApprovals
    // gate from the state gate.
    ch.state = 'idle';

    const promise = awaitChannelIdle(ch);

    let resolved = false;
    promise.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(800);
    expect(resolved).toBe(false);

    // Now release with idle:turnComplete (clears pendingApprovals).
    adapter.pushMessage(idleEvent(true));
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });

  it('does NOT enter grace when deferUntil is pending', async () => {
    vi.useFakeTimers();
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(ch.state).toBe('idle');

    let resolveDefer!: () => void;
    const defer = new Promise<void>((resolve) => { resolveDefer = resolve; });

    const promise = awaitChannelIdle(ch, { deferUntil: defer });
    let resolved = false;
    promise.then(() => { resolved = true; });

    // Past grace deadline — must not resolve because deferUntil is pending.
    await vi.advanceTimersByTimeAsync(800);
    expect(resolved).toBe(false);

    // Resolve defer; still no idle event since entry, so still pending.
    resolveDefer();
    await vi.advanceTimersByTimeAsync(800);
    expect(resolved).toBe(false);

    // Now drive idle:turnComplete to release.
    adapter.pushMessage(idleEvent(true));
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });
});

// ============================================================================
// 7. Post-then-wait race regression.
// ============================================================================

describe('awaitChannelIdle — post-then-wait race', () => {
  it('does not resolve in the grace window when activity arrives mid-grace', async () => {
    vi.useFakeTimers();
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(ch.state).toBe('idle');

    // Helper enters on idle channel — grace window starts.
    const promise = awaitChannelIdle(ch);

    // At t=50ms, adapter emits 'active' (turn that postMessage triggered
    // is now actually running).
    await vi.advanceTimersByTimeAsync(50);
    adapter.pushMessage(activeEvent);
    await vi.advanceTimersByTimeAsync(0);

    let resolved = false;
    promise.then(() => { resolved = true; });

    // Fast-forward through the original 500ms grace window — must not resolve.
    await vi.advanceTimersByTimeAsync(600);
    expect(resolved).toBe(false);

    // Real turn completion releases the helper.
    adapter.pushMessage(idleEvent(true));
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });
});

// ============================================================================
// 8. Background + turnComplete — authoritative turn-end with lingering bg work.
// ============================================================================

describe('awaitChannelIdle — background + turnComplete', () => {
  it('resolves immediately with turnComplete on background:turnComplete', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await tick();

    // Move to streaming so grace window doesn't fast-path.
    adapter.pushMessage(activeEvent);
    await tick();
    expect(ch.state).toBe('streaming');

    const promise = awaitChannelIdle(ch);
    adapter.pushMessage(backgroundEvent(true));
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });

  it('does NOT resolve on bare background event (no turnComplete)', async () => {
    vi.useFakeTimers();
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await vi.advanceTimersByTimeAsync(0);

    adapter.pushMessage(activeEvent);
    await vi.advanceTimersByTimeAsync(0);

    const promise = awaitChannelIdle(ch);
    adapter.pushMessage(backgroundEvent());
    await vi.advanceTimersByTimeAsync(0);

    let resolved = false;
    promise.then(() => { resolved = true; });
    // Past the IDLE_SETTLE_MS window — bare background must not auto-resolve.
    await vi.advanceTimersByTimeAsync(3000);
    expect(resolved).toBe(false);

    // Release with an authoritative event so the test cleans up.
    adapter.pushMessage(idleEvent(true));
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });

  it('active → background:turnComplete resolves immediately', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(activeEvent);
    await tick();
    expect(ch.state).toBe('streaming');

    const promise = awaitChannelIdle(ch);
    adapter.pushMessage(backgroundEvent(true));
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });

  it('idle:turnComplete still resolves immediately (regression)', async () => {
    const ch = createChannel('ch-1');
    const adapter = createMockAdapter();
    setAdapter(ch, adapter);
    await tick();

    adapter.pushMessage(activeEvent);
    await tick();

    const promise = awaitChannelIdle(ch);
    adapter.pushMessage(idleEvent(true));
    const reason = await promise;
    expect(reason).toBe('turnComplete');
    destroyChannel('ch-1');
  });
});
