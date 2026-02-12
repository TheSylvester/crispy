/**
 * Tests for ClaudeAgentAdapter (SDK adapter → AgentAdapter interface)
 *
 * Mocks `query()` from the Agent SDK. The adapter under test manages
 * input queues, SDKMessage routing, permission flows, and session lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelMessage } from '../src/core/agent-adapter.js';
import type { ChannelStatus } from '../src/core/channel-events.js';
import type { Options, SDKMessage, Query, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Mock: @anthropic-ai/claude-agent-sdk
// ---------------------------------------------------------------------------

let capturedOptions: Options | undefined;

/**
 * Minimal stub that satisfies the Query interface (AsyncGenerator + control
 * methods). Fed by an array of messages or a deferred push model.
 */
function makeQueryStub(
  messageSource: () => AsyncGenerator<SDKMessage, void>,
): Query {
  const gen = messageSource();
  return Object.assign(gen, {
    close: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
    initializationResult: vi.fn().mockResolvedValue({}),
    supportedCommands: vi.fn().mockResolvedValue([]),
    supportedModels: vi.fn().mockResolvedValue([]),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    accountInfo: vi.fn().mockResolvedValue({}),
    rewindFiles: vi.fn().mockResolvedValue({ canRewind: false }),
    reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
    toggleMcpServer: vi.fn().mockResolvedValue(undefined),
    setMcpServers: vi.fn().mockResolvedValue({ added: [], removed: [], errors: [] }),
    streamInput: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Query;
}

/** Create a Query that yields a fixed sequence then completes. */
function createMockQuery(messages: SDKMessage[]): Query {
  return makeQueryStub(async function* () {
    for (const msg of messages) yield msg;
  });
}

interface DeferredQuery {
  query: Query;
  pushMessage: (msg: SDKMessage) => void;
  complete: () => void;
  fail: (err: Error) => void;
}

/** Create a Query that stays open until explicitly completed / failed. */
function createDeferredQuery(): DeferredQuery {
  const buffer: SDKMessage[] = [];
  let waitResolve: ((value: IteratorResult<SDKMessage>) => void) | null = null;
  let waitReject: ((err: Error) => void) | null = null;
  let done = false;

  const query = makeQueryStub(async function* () {
    while (true) {
      if (buffer.length > 0) {
        yield buffer.shift()!;
        continue;
      }
      if (done) return;
      // Wait for the next push / complete / fail
      const result = await new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
        waitResolve = resolve;
        waitReject = reject;
      });
      waitResolve = null;
      waitReject = null;
      if (result.done) return;
      yield result.value;
    }
  });

  return {
    query,
    pushMessage(msg: SDKMessage) {
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        waitReject = null;
        r({ done: false, value: msg });
      } else {
        buffer.push(msg);
      }
    },
    complete() {
      done = true;
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        waitReject = null;
        r({ done: true, value: undefined as unknown as SDKMessage });
      }
    },
    fail(err: Error) {
      if (waitReject) {
        const r = waitReject;
        waitResolve = null;
        waitReject = null;
        r(err);
      }
    },
  };
}

const mockQueryFn = vi.fn<(params: { prompt: unknown; options?: Options }) => Query>();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQueryFn(args[0] as { prompt: unknown; options?: Options }),
}));

// Import AFTER the mock is registered (vitest auto-hoists vi.mock)
import { ClaudeAgentAdapter } from '../src/core/adapters/claude/claude-code-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect channel messages until `predicate` returns true, or timeout. */
async function collectUntil(
  channel: ClaudeAgentAdapter,
  predicate: (msgs: ChannelMessage[]) => boolean,
  timeoutMs = 500,
): Promise<ChannelMessage[]> {
  const collected: ChannelMessage[] = [];
  const iter = channel.messages()[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const race = await Promise.race([
      iter.next(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), Math.max(1, deadline - Date.now()))),
    ]);
    if (race === 'timeout') break;
    const result = race as IteratorResult<ChannelMessage>;
    if (result.done) break;
    collected.push(result.value);
    if (predicate(collected)) break;
  }

  return collected;
}

/** Tick the microtask queue so fire-and-forget drainOutput() advances. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedOptions = undefined;
  mockQueryFn.mockReset();
});

// ========== Group 1: Construction & defaults ==========

describe('Construction & defaults', () => {
  it('has correct defaults and respects resume', () => {
    const ch1 = new ClaudeAgentAdapter({ cwd: '/tmp' });
    expect(ch1.vendor).toBe('claude');
    expect(ch1.status).toBe('idle');
    expect(ch1.sessionId).toBeUndefined();
    expect(ch1.metadata).toBeNull();
    expect(ch1.contextUsage).toBeNull();

    const ch2 = new ClaudeAgentAdapter({ cwd: '/tmp', resume: 'abc' });
    expect(ch2.sessionId).toBe('abc');
  });
});

// ========== Group 2: send() guards ==========

describe('send() guards', () => {
  it('throws after close()', () => {
    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.close();
    expect(() => ch.send('hello')).toThrow('Channel is closed');
  });

  it('throws when awaiting approval', async () => {
    const deferred = createDeferredQuery();
    mockQueryFn.mockImplementation((params) => {
      capturedOptions = params.options;
      return deferred.query;
    });

    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('hi');
    await tick();

    // Trigger canUseTool to move status → awaiting_approval
    const canUseTool = capturedOptions!.canUseTool!;
    const ac = new AbortController();
    // Don't await — it blocks until resolved
    canUseTool('Bash', { command: 'ls' }, {
      signal: ac.signal,
      toolUseID: 'tu-1',
    });
    await tick();

    expect(ch.status).toBe('awaiting_approval');
    expect(() => ch.send('another')).toThrow('Cannot send while awaiting approval');

    // Cleanup
    ch.close();
  });

  it('reuses existing query on second send', async () => {
    const deferred = createDeferredQuery();
    mockQueryFn.mockReturnValue(deferred.query);

    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('first');
    await tick();
    expect(mockQueryFn).toHaveBeenCalledTimes(1);

    ch.send('second');
    await tick();
    expect(mockQueryFn).toHaveBeenCalledTimes(1); // still one query

    ch.close();
  });
});

// ========== Group 3: Message routing ==========

describe('Message routing', () => {
  it('routes all SDKMessage types correctly', async () => {
    // Cast via unknown — mock messages only need runtime-correct `type` fields.
    // The adapter reads properties dynamically, not via TS narrowing.
    const msg = (obj: Record<string, unknown>) => obj as unknown as SDKMessage;
    const messages: SDKMessage[] = [
      // system/init → entry
      msg({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'sonnet', cwd: '/tmp', apiKeySource: 'user', claude_code_version: '1.0.0', permissionMode: 'default', slash_commands: [], output_style: 'normal', skills: [], plugins: [], uuid: 'u1', session_id: 's1' }),
      // assistant → active status + entry
      msg({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null, uuid: 'u2', session_id: 's1' }),
      // user → entry
      msg({ type: 'user', message: { role: 'user', content: 'test' }, parent_tool_use_id: null, session_id: 's1' }),
      // user with isReplay → skipped
      msg({ type: 'user', message: { role: 'user', content: 'old' }, parent_tool_use_id: null, isReplay: true, uuid: 'u3', session_id: 's1' }),
      // system/status compacting → compacting notification
      msg({ type: 'system', subtype: 'status', status: 'compacting', uuid: 'u5', session_id: 's1' }),
      // system/status permissionMode → permission_mode_changed notification
      msg({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits', uuid: 'u6', session_id: 's1' }),
      // system/compact_boundary → entry
      msg({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1000 }, uuid: 'u7', session_id: 's1' }),
      // system without subtype → entry (fallback)
      msg({ type: 'system', uuid: 'u8', session_id: 's1' }),
      // stream_event → entry
      msg({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null, uuid: 'u9', session_id: 's1' }),
      // tool_progress → no output
      msg({ type: 'tool_progress', tool_use_id: 'tu1', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 2, uuid: 'u10', session_id: 's1' }),
      // auth_status → no output
      msg({ type: 'auth_status', isAuthenticating: false, output: [], uuid: 'u11', session_id: 's1' }),
      // unknown type → entry (default case)
      msg({ type: 'tool_use_summary', summary: 'Ran Bash', preceding_tool_use_ids: ['tu1'], uuid: 'u12', session_id: 's1' }),
      // result → entry (last entry-producing message; emits idle so must come after all others)
      msg({ type: 'result', subtype: 'success', duration_ms: 100, duration_api_ms: 50, is_error: false, num_turns: 1, result: 'done', stop_reason: 'end_turn', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {}, permission_denials: [], uuid: 'u4', session_id: 's1' }),
    ];

    const mockQ = createMockQuery(messages);
    mockQueryFn.mockReturnValue(mockQ);

    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('go');

    // Collect until we see the idle status (query completed)
    const output = await collectUntil(ch, (msgs) =>
      msgs.some((m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'idle'),
    );

    // Count entries vs events
    const entries = output.filter((m) => m.type === 'entry');
    const events = output.filter((m) => m.type === 'event');

    // Entries: init, assistant, user (not replay), compact_boundary,
    //          system-no-subtype, stream_event, tool_use_summary, result = 8
    expect(entries.length).toBe(8);

    // Events: session_changed (first session_id), active (from startQuery),
    //         compacting, permission_mode_changed, idle = 5
    const eventKinds = events.map((m) => {
      if (m.type !== 'event') return '';
      return m.event.type === 'status' ? m.event.status : (m.event as { kind?: string }).kind ?? '';
    });
    expect(eventKinds).toContain('active');
    expect(eventKinds).toContain('idle');
    expect(eventKinds).toContain('compacting');
    expect(eventKinds).toContain('permission_mode_changed');
    expect(eventKinds).toContain('session_changed');

    ch.close();
  });
});

// ========== Group 4: Session tracking ==========

describe('Session tracking', () => {
  it('emits session_changed on new / different session_id', async () => {
    const deferred = createDeferredQuery();
    mockQueryFn.mockReturnValue(deferred.query);

    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('start');
    await tick();

    // First message with session_id → session_changed (no previousSessionId)
    deferred.pushMessage({ type: 'user', message: { role: 'user', content: 'a' }, parent_tool_use_id: null, session_id: 'sess-1' } as unknown as SDKMessage);
    await tick();

    // Same session_id → no event
    deferred.pushMessage({ type: 'user', message: { role: 'user', content: 'b' }, parent_tool_use_id: null, session_id: 'sess-1' } as unknown as SDKMessage);
    await tick();

    // Different session_id → session_changed with previousSessionId
    deferred.pushMessage({ type: 'user', message: { role: 'user', content: 'c' }, parent_tool_use_id: null, session_id: 'sess-2' } as unknown as SDKMessage);
    await tick();

    deferred.complete();

    const output = await collectUntil(ch, (msgs) =>
      msgs.some((m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'idle'),
    );

    const sessionEvents = output.filter(
      (m) => m.type === 'event' && m.event.type === 'notification' && (m.event as { kind: string }).kind === 'session_changed',
    );

    expect(sessionEvents.length).toBe(2);

    // First: no previousSessionId
    const first = (sessionEvents[0] as { type: 'event'; event: { sessionId: string; previousSessionId?: string } }).event;
    expect(first.sessionId).toBe('sess-1');
    expect(first.previousSessionId).toBeUndefined();

    // Second: has previousSessionId
    const second = (sessionEvents[1] as { type: 'event'; event: { sessionId: string; previousSessionId?: string } }).event;
    expect(second.sessionId).toBe('sess-2');
    expect(second.previousSessionId).toBe('sess-1');

    ch.close();
  });
});

// ========== Group 5: Permission flow ==========

describe('Permission flow', () => {
  /** Helper to set up a channel with a deferred query and return canUseTool. */
  function setupWithCanUseTool() {
    const deferred = createDeferredQuery();
    mockQueryFn.mockImplementation((params) => {
      capturedOptions = params.options;
      return deferred.query;
    });
    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('hi');
    return { ch, deferred, getCanUseTool: () => capturedOptions!.canUseTool! };
  }

  it('full allow flow', async () => {
    const { ch, deferred, getCanUseTool } = setupWithCanUseTool();
    await tick();

    const canUseTool = getCanUseTool();
    const ac = new AbortController();
    const resultPromise = canUseTool('Bash', { command: 'ls' }, {
      signal: ac.signal,
      toolUseID: 'tu-1',
      decisionReason: 'needs permission',
    });
    await tick();

    expect(ch.status).toBe('awaiting_approval');

    // Collect the awaiting_approval event
    // (it was already enqueued, we just need to read it)

    ch.respondToApproval('tu-1', 'allow');
    const result = await resultPromise;
    expect(result.behavior).toBe('allow');
    expect(ch.status).toBe('active');

    deferred.complete();
    ch.close();
  });

  it('deny flow', async () => {
    const { ch, deferred, getCanUseTool } = setupWithCanUseTool();
    await tick();

    const canUseTool = getCanUseTool();
    const ac = new AbortController();
    const resultPromise = canUseTool('Bash', { command: 'rm -rf /' }, {
      signal: ac.signal,
      toolUseID: 'tu-2',
    });
    await tick();

    ch.respondToApproval('tu-2', 'deny');
    const result = await resultPromise;
    expect(result.behavior).toBe('deny');
    expect((result as { message: string }).message).toBe('User denied');

    deferred.complete();
    ch.close();
  });

  it('allow_session with suggestions', async () => {
    const { ch, deferred, getCanUseTool } = setupWithCanUseTool();
    await tick();

    const canUseTool = getCanUseTool();
    const ac = new AbortController();
    const suggestions: PermissionUpdate[] = [
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow' as never, destination: 'session' },
    ];

    const resultPromise = canUseTool('Bash', { command: 'echo hi' }, {
      signal: ac.signal,
      toolUseID: 'tu-3',
      suggestions,
    });
    await tick();

    // The awaiting_approval event should include allow_session option
    ch.respondToApproval('tu-3', 'allow_session');
    const result = await resultPromise;
    expect(result.behavior).toBe('allow');
    expect((result as { updatedPermissions?: PermissionUpdate[] }).updatedPermissions).toEqual(suggestions);

    deferred.complete();
    ch.close();
  });

  it('validation: unknown toolUseId, invalid optionId, aborted signal', async () => {
    const { ch, deferred, getCanUseTool } = setupWithCanUseTool();
    await tick();

    // Unknown toolUseId
    expect(() => ch.respondToApproval('nonexistent', 'allow')).toThrow('No pending approval');

    // Trigger a real approval so we can test invalid optionId
    const canUseTool = getCanUseTool();
    const ac1 = new AbortController();
    canUseTool('Bash', { command: 'ls' }, { signal: ac1.signal, toolUseID: 'tu-4' });
    await tick();

    expect(() => ch.respondToApproval('tu-4', 'bogus')).toThrow("Invalid optionId 'bogus'");

    // Resolve the pending one to clean up
    ch.respondToApproval('tu-4', 'allow');
    await tick();

    // Already-aborted signal → immediate deny without emitting event
    const ac2 = new AbortController();
    ac2.abort();
    const result = await canUseTool('Bash', { command: 'nope' }, {
      signal: ac2.signal,
      toolUseID: 'tu-5',
    });
    expect(result.behavior).toBe('deny');
    expect((result as { message: string }).message).toBe('Aborted');

    deferred.complete();
    ch.close();
  });
});

// ========== Group 6: Concurrent approvals ==========

describe('Concurrent approvals', () => {
  it('tracks multiple pending approvals independently', async () => {
    const deferred = createDeferredQuery();
    mockQueryFn.mockImplementation((params) => {
      capturedOptions = params.options;
      return deferred.query;
    });

    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('go');
    await tick();

    const canUseTool = capturedOptions!.canUseTool!;
    const ac = new AbortController();

    const p1 = canUseTool('Bash', { command: 'a' }, { signal: ac.signal, toolUseID: 'tu-a' });
    await tick();
    const p2 = canUseTool('Read', { file_path: '/x' }, { signal: ac.signal, toolUseID: 'tu-b' });
    await tick();

    expect(ch.status).toBe('awaiting_approval');

    // Resolve first — still awaiting because second is pending
    ch.respondToApproval('tu-a', 'allow');
    await p1;
    expect(ch.status).toBe('awaiting_approval');

    // Resolve second → active
    ch.respondToApproval('tu-b', 'allow');
    await p2;
    expect(ch.status).toBe('active');

    deferred.complete();
    ch.close();
  });
});

// ========== Group 7: close() & lifecycle ==========

describe('close() & lifecycle', () => {
  it('close() emits idle + completes stream; second close is no-op', async () => {
    const deferred = createDeferredQuery();
    mockQueryFn.mockReturnValue(deferred.query);

    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('go');
    await tick();

    ch.close();

    const output = await collectUntil(ch, () => false, 100);
    // Should contain at least the initial 'active' and the final 'idle'
    const statuses = output
      .filter((m) => m.type === 'event' && m.event.type === 'status')
      .map((m) => (m as { type: 'event'; event: { status: ChannelStatus } }).event.status);
    expect(statuses).toContain('active');
    expect(statuses).toContain('idle');

    // Second close is a no-op (no throw)
    ch.close();
  });

  it('close() with pending approval resolves as deny', async () => {
    const deferred = createDeferredQuery();
    mockQueryFn.mockImplementation((params) => {
      capturedOptions = params.options;
      return deferred.query;
    });

    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('go');
    await tick();

    const canUseTool = capturedOptions!.canUseTool!;
    const ac = new AbortController();
    const resultPromise = canUseTool('Bash', { command: 'ls' }, {
      signal: ac.signal,
      toolUseID: 'tu-close',
    });
    await tick();

    ch.close();
    const result = await resultPromise;
    expect(result.behavior).toBe('deny');
    expect((result as { message: string }).message).toBe('Session ended');
  });

  it('query error emits error notification, channel goes idle', async () => {
    const deferred = createDeferredQuery();
    mockQueryFn.mockReturnValue(deferred.query);

    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('go');
    await tick();

    deferred.fail(new Error('SDK crash'));

    const output = await collectUntil(
      ch,
      (msgs) => msgs.some((m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'idle'),
      500,
    );

    const errorEvent = output.find(
      (m) => m.type === 'event' && m.event.type === 'notification' && (m.event as { kind: string }).kind === 'error',
    );
    expect(errorEvent).toBeDefined();

    const idleEvent = output.find(
      (m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'idle',
    );
    expect(idleEvent).toBeDefined();
    expect(ch.status).toBe('idle');

    ch.close();
  });

  it('query completes normally → idle status', async () => {
    const mockQ = createMockQuery([
      { type: 'user', message: { role: 'user', content: 'hi' }, parent_tool_use_id: null, session_id: 's1' } as unknown as SDKMessage,
    ]);
    mockQueryFn.mockReturnValue(mockQ);

    const ch = new ClaudeAgentAdapter({ cwd: '/tmp' });
    ch.send('go');

    const output = await collectUntil(
      ch,
      (msgs) => msgs.some((m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'idle'),
    );

    const idleEvent = output.find(
      (m) => m.type === 'event' && m.event.type === 'status' && m.event.status === 'idle',
    );
    expect(idleEvent).toBeDefined();
    expect(ch.status).toBe('idle');

    ch.close();
  });
});

// ========== Group 8: sdkOptions invariants ==========

describe('sdkOptions invariants', () => {
  it('adapter invariants override user sdkOptions; passthrough fields forwarded', async () => {
    const fakeAbort = new AbortController();
    const deferred = createDeferredQuery();
    mockQueryFn.mockImplementation((params) => {
      capturedOptions = params.options;
      return deferred.query;
    });

    const ch = new ClaudeAgentAdapter({
      cwd: '/my/project',
      model: 'opus',
      permissionMode: 'acceptEdits',
      resume: 'resume-123',
      // This should be overridden by adapter invariants:
      abortController: fakeAbort,
    });

    ch.send('test');
    await tick();

    // Invariants: adapter's own values, NOT the user's
    expect(capturedOptions!.abortController).not.toBe(fakeAbort);
    expect(capturedOptions!.includePartialMessages).toBe(true);
    expect(capturedOptions!.canUseTool).toBeDefined();

    // Passthrough fields
    expect(capturedOptions!.cwd).toBe('/my/project');
    expect(capturedOptions!.model).toBe('opus');
    expect(capturedOptions!.permissionMode).toBe('acceptEdits');
    expect(capturedOptions!.resume).toBe('resume-123');

    deferred.complete();
    ch.close();
  });
});
