/**
 * Tests for Client Connection — Client->Host request routing
 *
 * Uses MockDiscovery for stateless session operations (findSession,
 * listSessions, loadHistory) and MockAdapter for live session streaming.
 * Exercises all 11 methods via mock sendFn, verifies SubscriberEvent
 * forwarding, request/response correlation, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncIterableQueue } from '../src/core/async-iterable-queue.js';
import type {
  AgentAdapter,
  AdapterSettings,
  VendorDiscovery,
  SessionInfo,
  ChannelMessage,
} from '../src/core/agent-adapter.js';
import type { TranscriptEntry, MessageContent, Vendor } from '../src/core/transcript.js';
import type { ChannelStatus } from '../src/core/channel-events.js';
import {
  _resetRegistry as _resetChannelRegistry,
} from '../src/core/session-channel.js';

import {
  registerAdapter,
  _resetRegistry,
} from '../src/core/session-manager.js';
import type { OpenSessionInfo } from '../src/core/session-manager.js';
import { _setTestDir, setSessionKind } from '../src/core/activity-index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import {
  createClientConnection,
  type HostMessage,
} from '../src/host/client-connection.js';
import { createAgentDispatch } from '../src/host/agent-dispatch.js';

// ============================================================================
// Mock Discovery
// ============================================================================

function createMockDiscovery(options?: {
  vendor?: Vendor;
  sessions?: SessionInfo[];
  historyEntries?: TranscriptEntry[];
}): VendorDiscovery & {
  findSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  loadHistory: ReturnType<typeof vi.fn>;
} {
  const vendor: Vendor = options?.vendor ?? 'claude';
  const sessions = options?.sessions ?? [];
  const historyEntries = options?.historyEntries ?? [];
  return {
    vendor,
    findSession: vi.fn((_id: string): SessionInfo | undefined => sessions.find((s) => s.sessionId === _id)),
    listSessions: vi.fn((): SessionInfo[] => sessions),
    loadHistory: vi.fn(async (_id: string): Promise<TranscriptEntry[]> => historyEntries),
  } as VendorDiscovery & {
    findSession: ReturnType<typeof vi.fn>;
    listSessions: ReturnType<typeof vi.fn>;
    loadHistory: ReturnType<typeof vi.fn>;
  };
}

// ============================================================================
// Mock Adapter (live session only — no discovery methods)
// ============================================================================

interface MockAdapter extends AgentAdapter {
  pushMessage(msg: ChannelMessage): void;
  completeStream(): void;
  readonly outputQueue: AsyncIterableQueue<ChannelMessage>;
}

function createMockAdapter(options?: { vendor?: Vendor }): MockAdapter {
  const queue = new AsyncIterableQueue<ChannelMessage>();
  const vendor: Vendor = options?.vendor ?? 'claude';
  let status: ChannelStatus = 'idle';

  return {
    vendor,
    get sessionId() { return undefined; },
    get status() { return status; },
    get contextUsage() { return null; },
    get settings(): AdapterSettings {
      return { model: undefined, permissionMode: undefined, allowDangerouslySkipPermissions: false, extraArgs: undefined };
    },
    outputQueue: queue,

    messages(): AsyncIterable<ChannelMessage> {
      return queue;
    },

    sendTurn: vi.fn((_content: MessageContent) => {}),
    respondToApproval: vi.fn((_toolUseId: string, _optionId: string) => {}),

    close: vi.fn(() => {
      queue.done();
    }),

    interrupt: vi.fn(async () => {}),
    setModel: vi.fn(async (_model?: string) => {}),
    setPermissionMode: vi.fn(async (_mode: string) => {}),

    pushMessage(msg: ChannelMessage): void {
      queue.enqueue(msg);
    },

    completeStream(): void {
      queue.done();
    },
  };
}

/**
 * Create a factory that captures the last adapter it created.
 * Tests can call lastCreated() to get the factory-created adapter
 * (the one actually wired into the channel) to push messages, assert calls, etc.
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
// Helpers
// ============================================================================

function makeSessionInfo(overrides: Partial<SessionInfo> & { sessionId: string; vendor: Vendor }): SessionInfo {
  return {
    path: `/sessions/${overrides.sessionId}`,
    projectSlug: 'test-project',
    modifiedAt: new Date('2025-01-15T12:00:00Z'),
    size: 1024,
    ...overrides,
  };
}

/** Wait for microtasks to settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Collect all messages sent by the handler. */
function createMockSend(): { messages: HostMessage[]; sendFn: (msg: HostMessage) => void } {
  const messages: HostMessage[] = [];
  return {
    messages,
    sendFn: (msg: HostMessage) => messages.push(msg),
  };
}

/** Send a request and return the response message from the collected messages. */
async function sendRequestAndGetResponse(
  handler: ReturnType<typeof createClientConnection>,
  sendMessages: HostMessage[],
  method: string,
  params?: Record<string, unknown>,
): Promise<HostMessage> {
  const id = `test-${method}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const beforeCount = sendMessages.length;
  await handler.handleMessage({
    kind: 'request',
    id,
    method,
    params,
  });
  // Find the response with matching id
  const response = sendMessages.find(
    (m) => (m.kind === 'response' || m.kind === 'error') && m.id === id,
  );
  if (!response) {
    throw new Error(`No response found for request id "${id}". Messages: ${sendMessages.length - beforeCount} new`);
  }
  return response;
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
// Tests
// ============================================================================

describe('ClientConnection', () => {
  describe('listSessions', () => {
    it('returns all sessions from registered adapters', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const s2 = makeSessionInfo({ sessionId: 'sess-2', vendor: 'claude', modifiedAt: new Date('2025-06-01') });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1, s2] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      const resp = await sendRequestAndGetResponse(handler, messages, 'listSessions');
      expect(resp.kind).toBe('response');
      if (resp.kind === 'response') {
        const result = resp.result as SessionInfo[];
        expect(result).toHaveLength(2);
      }

      handler.dispose();
    });
  });

  describe('findSession', () => {
    it('finds a session by ID', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      const resp = await sendRequestAndGetResponse(handler, messages, 'findSession', { sessionId: 'sess-1' });
      expect(resp.kind).toBe('response');
      if (resp.kind === 'response') {
        const result = resp.result as SessionInfo;
        expect(result.sessionId).toBe('sess-1');
      }

      handler.dispose();
    });

    it('returns null when not found', async () => {
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      const resp = await sendRequestAndGetResponse(handler, messages, 'findSession', { sessionId: 'nonexistent' });
      expect(resp.kind).toBe('response');
      if (resp.kind === 'response') {
        expect(resp.result).toBeNull();
      }

      handler.dispose();
    });
  });

  describe('loadSession', () => {
    it('loads transcript entries for a session', async () => {
      const entries: TranscriptEntry[] = [
        { type: 'user', message: { role: 'user', content: 'hello' } },
        { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
      ];
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1], historyEntries: entries });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      const resp = await sendRequestAndGetResponse(handler, messages, 'loadSession', { sessionId: 'sess-1' });
      expect(resp.kind).toBe('response');
      if (resp.kind === 'response') {
        const result = resp.result as TranscriptEntry[];
        expect(result).toHaveLength(2);
      }

      handler.dispose();
    });
  });

  describe('subscribe + event forwarding', () => {
    it('subscribes to a session and forwards events', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      // Subscribe
      const resp = await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });
      expect(resp.kind).toBe('response');

      // Push a transcript entry through the factory-created adapter (not discovery!)
      const entry: TranscriptEntry = { type: 'assistant', message: { role: 'assistant', content: 'hello' } };
      lastCreated().pushMessage({ type: 'entry', entry });
      await tick();

      // Should have received an event message
      const eventMessages = messages.filter((m) => m.kind === 'event');
      expect(eventMessages.length).toBeGreaterThanOrEqual(1);

      const entryEvent = eventMessages.find(
        (m) => m.kind === 'event' && (m as any).event.type === 'entry',
      );
      expect(entryEvent).toBeDefined();
      if (entryEvent && entryEvent.kind === 'event') {
        expect(entryEvent.sessionId).toBe('sess-1');
      }

      handler.dispose();
    });

    it('does not double-subscribe', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });
      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });

      // Push one entry — should only get one event (not two)
      const entry: TranscriptEntry = { type: 'user', message: { role: 'user', content: 'test' } };
      lastCreated().pushMessage({ type: 'entry', entry });
      await tick();

      const entryEvents = messages.filter(
        (m) => m.kind === 'event' && (m as any).event.type === 'entry',
      );
      expect(entryEvents).toHaveLength(1);

      handler.dispose();
    });

    it('replays catchup on an existing subscription', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const historyEntries: TranscriptEntry[] = [
        { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: 'hello' } },
      ];
      const discovery = createMockDiscovery({
        vendor: 'claude',
        sessions: [s1],
        historyEntries,
      });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });
      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });

      const catchups = messages.filter(
        (m) => m.kind === 'event' && (m as any).event.type === 'catchup',
      );
      expect(catchups).toHaveLength(2);
      if (catchups[1]?.kind === 'event' && catchups[1].event.type === 'catchup') {
        expect(catchups[1].sessionId).toBe('sess-1');
        expect(catchups[1].event.entries).toEqual(historyEntries);
      }

      handler.dispose();
    });
  });

  describe('unsubscribe', () => {
    it('stops receiving events after unsubscribe', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });
      await sendRequestAndGetResponse(handler, messages, 'unsubscribe', { sessionId: 'sess-1' });

      // Push an entry — should NOT receive it
      const beforeCount = messages.length;
      lastCreated().pushMessage({
        type: 'entry',
        entry: { type: 'user', message: { role: 'user', content: 'after unsub' } },
      });
      await tick();

      const newEvents = messages.slice(beforeCount).filter((m) => m.kind === 'event');
      expect(newEvents).toHaveLength(0);

      handler.dispose();
    });
  });

  describe('resolveApproval', () => {
    it('resolves an approval on a subscribed session', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });

      // Simulate an approval request from the adapter
      lastCreated().pushMessage({
        type: 'event',
        event: {
          type: 'status',
          status: 'awaiting_approval',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          input: { command: 'rm -rf /' },
          options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
        },
      });
      await tick();

      // Resolve the approval
      const resp = await sendRequestAndGetResponse(handler, messages, 'resolveApproval', {
        sessionId: 'sess-1',
        toolUseId: 'tool-1',
        optionId: 'allow',
      });
      expect(resp.kind).toBe('response');
      expect(lastCreated().respondToApproval).toHaveBeenCalledWith('tool-1', 'allow', {});

      handler.dispose();
    });

    it('errors when not subscribed', async () => {
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      const resp = await sendRequestAndGetResponse(handler, messages, 'resolveApproval', {
        sessionId: 'sess-1',
        toolUseId: 'tool-1',
        optionId: 'allow',
      });
      expect(resp.kind).toBe('error');

      handler.dispose();
    });
  });

  describe('interrupt', () => {
    it('delegates to adapter.interrupt()', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });

      const resp = await sendRequestAndGetResponse(handler, messages, 'interrupt', {
        sessionId: 'sess-1',
      });
      expect(resp.kind).toBe('response');
      expect(lastCreated().interrupt).toHaveBeenCalled();

      handler.dispose();
    });
  });

  describe('close', () => {
    it('closes a session and cleans up subscription', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });

      const resp = await sendRequestAndGetResponse(handler, messages, 'close', {
        sessionId: 'sess-1',
      });
      expect(resp.kind).toBe('response');

      // Sending to the closed session should now error
      const sendResp = await sendRequestAndGetResponse(handler, messages, 'send', {
        sessionId: 'sess-1',
        content: 'hello',
      });
      expect(sendResp.kind).toBe('error');

      handler.dispose();
    });
  });

  describe('unknown method', () => {
    it('returns an error for unknown methods', async () => {
      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      const resp = await sendRequestAndGetResponse(handler, messages, 'nonexistentMethod');
      expect(resp.kind).toBe('error');
      if (resp.kind === 'error') {
        expect(resp.error).toContain('Unknown method');
      }

      handler.dispose();
    });
  });

  describe('malformed messages', () => {
    it('ignores messages without kind=request', async () => {
      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await handler.handleMessage({ kind: 'not-a-request', id: '1', method: 'listSessions' });
      expect(messages).toHaveLength(0);

      handler.dispose();
    });

    it('handles string messages (JSON parsing)', async () => {
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await handler.handleMessage(JSON.stringify({
        kind: 'request',
        id: 'str-1',
        method: 'listSessions',
      }));

      const resp = messages.find((m) => m.kind === 'response' && m.id === 'str-1');
      expect(resp).toBeDefined();

      handler.dispose();
    });
  });

  describe('listOpenSessions', () => {
    // listOpenSessions consults isSystemSession which reads the DB; give
    // each test an isolated ~/.crispy/ so setSessionKind can persist and
    // state from one test doesn't leak into another.
    let testDir: string;
    let cleanupDir: () => void;

    beforeEach(() => {
      testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-list-open-rpc-'));
      cleanupDir = _setTestDir(testDir);
    });

    afterEach(() => {
      cleanupDir();
      fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });

    it('returns an empty list when no channels are open', async () => {
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      const resp = await sendRequestAndGetResponse(handler, messages, 'listOpenSessions', {});
      expect(resp.kind).toBe('response');
      if (resp.kind === 'response') {
        expect(resp.result).toEqual([]);
      }

      handler.dispose();
    });

    it('includes subscribed sessions with default filters', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });
      const resp = await sendRequestAndGetResponse(handler, messages, 'listOpenSessions', {});

      expect(resp.kind).toBe('response');
      if (resp.kind === 'response') {
        const result = resp.result as OpenSessionInfo[];
        expect(result).toHaveLength(1);
        expect(result[0].sessionId).toBe('sess-1');
        expect(result[0].vendor).toBe('claude');
      }

      handler.dispose();
    });

    it('honors includeSystem: true to surface Rosie-like sessions', async () => {
      const sUser = makeSessionInfo({ sessionId: 'sess-user', vendor: 'claude' });
      const sSys = makeSessionInfo({ sessionId: 'sess-sys', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [sUser, sSys] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-user' });
      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-sys' });
      setSessionKind('sess-sys', 'system');

      // Default: system hidden.
      const def = await sendRequestAndGetResponse(handler, messages, 'listOpenSessions', {});
      if (def.kind === 'response') {
        const ids = (def.result as OpenSessionInfo[]).map((r) => r.sessionId);
        expect(ids).toEqual(['sess-user']);
      }

      // Opt-in.
      const full = await sendRequestAndGetResponse(handler, messages, 'listOpenSessions', {
        includeSystem: true,
      });
      if (full.kind === 'response') {
        const result = full.result as OpenSessionInfo[];
        expect(result.map((r) => r.sessionId)).toEqual(['sess-sys', 'sess-user']);
        expect(result.find((r) => r.sessionId === 'sess-sys')!.sessionKind).toBe('system');
      }

      handler.dispose();
    });

    it('in-process loopback: dispatch sees sessions opened by another client', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-shared', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      // Client A subscribes to the session.
      const { messages, sendFn } = createMockSend();
      const clientA = createClientConnection('client-A', sendFn);
      await sendRequestAndGetResponse(clientA, messages, 'subscribe', { sessionId: 'sess-shared' });

      // A second in-process client (e.g. a dispatched agent) queries
      // listOpenSessions via the typed AgentDispatch surface.
      const dispatch = createAgentDispatch();
      const result = await dispatch.listOpenSessions();
      expect(result.map((r) => r.sessionId)).toContain('sess-shared');

      dispatch.dispose();
      clientA.dispose();
    });
  });

  describe('postMessage', () => {
    async function setupSubscribed(sessionId: string) {
      const s1 = makeSessionInfo({ sessionId, vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId });
      return { messages, sendFn, handler, adapter: lastCreated() };
    }

    it('delivers to an idle target — adapter receives sendTurn', async () => {
      const { messages, handler, adapter } = await setupSubscribed('sess-post-1');
      const sendSpy = adapter.sendTurn as unknown as ReturnType<typeof vi.fn>;
      const callsBefore = sendSpy.mock.calls.length;

      const resp = await sendRequestAndGetResponse(handler, messages, 'postMessage', {
        sessionId: 'sess-post-1',
        content: 'hello from peer',
      });
      expect(resp.kind).toBe('response');
      if (resp.kind === 'response') {
        expect(resp.result).toEqual({ sessionId: 'sess-post-1' });
      }
      expect(sendSpy.mock.calls.length).toBe(callsBefore + 1);

      handler.dispose();
    });

    it('delivers to a streaming target (permissive policy)', async () => {
      const { messages, handler, adapter } = await setupSubscribed('sess-post-2');
      // Drive channel into streaming.
      adapter.pushMessage({ type: 'event', event: { type: 'status', status: 'active' } });
      await tick();
      const sendSpy = adapter.sendTurn as unknown as ReturnType<typeof vi.fn>;
      const callsBefore = sendSpy.mock.calls.length;

      const resp = await sendRequestAndGetResponse(handler, messages, 'postMessage', {
        sessionId: 'sess-post-2',
        content: 'mid-turn poke',
      });
      expect(resp.kind).toBe('response');
      if (resp.kind === 'response') {
        expect(resp.result).toEqual({ sessionId: 'sess-post-2' });
      }
      expect(sendSpy.mock.calls.length).toBe(callsBefore + 1);

      handler.dispose();
    });

    it('rejects unknown sessionId with "Session not active"', async () => {
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'postMessage', {
        sessionId: 'nonexistent-id',
        content: 'hi',
      });
      expect(resp.kind).toBe('error');
      if (resp.kind === 'error') {
        expect(resp.error).toBe('Session not active: nonexistent-id');
      }
      handler.dispose();
    });

    it('rejects pending IDs explicitly when channel is otherwise live', async () => {
      const { createChannel, setAdapter } = await import('../src/core/session-channel.js');
      const pendingCh = createChannel('pending:post-test-1');
      const adapter = createMockAdapter({ vendor: 'claude' });
      setAdapter(pendingCh, adapter);
      await tick();
      expect(pendingCh.state).not.toBe('unattached');
      expect(pendingCh.tearing).toBe(false);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'postMessage', {
        sessionId: 'pending:post-test-1',
        content: 'hi',
      });
      expect(resp.kind).toBe('error');
      if (resp.kind === 'error') {
        expect(resp.error).toBe('Session not active: pending:post-test-1');
      }
      handler.dispose();
    });

    it('no caller subscription required to call postMessage', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-post-nocaller', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      // Other client subscribes — installs the channel.
      const otherMessages: HostMessage[] = [];
      const otherHandler = createClientConnection('client-other', (m) => otherMessages.push(m));
      await sendRequestAndGetResponse(otherHandler, otherMessages, 'subscribe', { sessionId: 'sess-post-nocaller' });
      const adapter = lastCreated();

      // Fresh client — never subscribed — calls postMessage successfully.
      const { messages: callerMessages, sendFn } = createMockSend();
      const callerHandler = createClientConnection('client-caller', sendFn);
      const sendSpy = adapter.sendTurn as unknown as ReturnType<typeof vi.fn>;
      const callsBefore = sendSpy.mock.calls.length;

      const resp = await sendRequestAndGetResponse(callerHandler, callerMessages, 'postMessage', {
        sessionId: 'sess-post-nocaller',
        content: 'hi from non-subscriber',
      });
      expect(resp.kind).toBe('response');
      expect(sendSpy.mock.calls.length).toBe(callsBefore + 1);

      callerHandler.dispose();
      otherHandler.dispose();
    });

    it('rejects empty content with the expected message', async () => {
      const { messages, handler } = await setupSubscribed('sess-post-empty');
      const resp = await sendRequestAndGetResponse(handler, messages, 'postMessage', {
        sessionId: 'sess-post-empty',
        content: '',
      });
      expect(resp.kind).toBe('error');
      if (resp.kind === 'error') {
        expect(resp.error).toBe('postMessage: content must be non-empty string or MessageContent');
      }
      handler.dispose();
    });

    it('strips caller-supplied target.model — never triggers vendor switch path', async () => {
      const { messages, handler, adapter } = await setupSubscribed('sess-post-strip');
      const sendSpy = adapter.sendTurn as unknown as ReturnType<typeof vi.fn>;
      const callsBefore = sendSpy.mock.calls.length;

      // Caller passes a `target` shape — the handler should ignore it
      // and build its own intent. Caller's `model: codex:o3` would, if
      // forwarded, trigger the vendor-switch branch in sendTurn. We
      // don't even pass `target` from the RPC payload — the handler
      // constructs `target: { kind: 'existing', sessionId: resolvedId }`
      // unconditionally. Test that.
      const resp = await sendRequestAndGetResponse(handler, messages, 'postMessage', {
        sessionId: 'sess-post-strip',
        content: 'hi',
        // Even if we tried to inject target/model fields, they wouldn't
        // be forwarded — but pass them defensively to verify.
        target: { kind: 'existing', sessionId: 'wrong-id', model: 'codex:o3' },
        clientMessageId: 'cmid-1',
      });
      expect(resp.kind).toBe('response');
      // The adapter for the actual session received the message — not
      // a switched-vendor adapter, not a different session.
      expect(sendSpy.mock.calls.length).toBe(callsBefore + 1);

      handler.dispose();
    });
  });

  describe('waitForIdle', () => {
    async function setupSubscribed(sessionId: string) {
      const s1 = makeSessionInfo({ sessionId, vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId });
      return { messages, sendFn, handler, adapter: lastCreated() };
    }

    it('resolves with turnComplete when target emits authoritative idle', async () => {
      const { messages, handler, adapter } = await setupSubscribed('sess-wait-1');
      const id = `req-waitForIdle-1`;
      // Fire the request without awaiting — it blocks on the helper.
      const msgPromise = handler.handleMessage({
        kind: 'request', id, method: 'waitForIdle', params: { sessionId: 'sess-wait-1' },
      });
      await tick();
      // Move channel out of idle so the grace window doesn't fast-path.
      adapter.pushMessage({ type: 'event', event: { type: 'status', status: 'active' } });
      await tick();
      adapter.pushMessage({ type: 'event', event: { type: 'status', status: 'idle', turnComplete: true } });
      await msgPromise;
      const resp = messages.find((m) => (m.kind === 'response' || m.kind === 'error') && m.id === id);
      expect(resp?.kind).toBe('response');
      if (resp?.kind === 'response') {
        expect(resp.result).toEqual({ reason: 'turnComplete' });
      }
      handler.dispose();
    });

    it('resolves with timeout when timeoutMs elapses', async () => {
      const { messages, handler, adapter } = await setupSubscribed('sess-wait-2');
      // Move channel out of idle so the grace window doesn't fire.
      adapter.pushMessage({ type: 'event', event: { type: 'status', status: 'active' } });
      await tick();
      const id = `req-waitForIdle-2`;
      const msgPromise = handler.handleMessage({
        kind: 'request', id, method: 'waitForIdle',
        params: { sessionId: 'sess-wait-2', timeoutMs: 50 },
      });
      await msgPromise;
      const resp = messages.find((m) => (m.kind === 'response' || m.kind === 'error') && m.id === id);
      expect(resp?.kind).toBe('response');
      if (resp?.kind === 'response') {
        expect(resp.result).toEqual({ reason: 'timeout' });
      }
      handler.dispose();
    });

    it('throws "Session not active" for unknown sessionId', async () => {
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));
      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'waitForIdle', {
        sessionId: 'nonexistent-id',
      });
      expect(resp.kind).toBe('error');
      if (resp.kind === 'error') {
        expect(resp.error).toBe('Session not active: nonexistent-id');
      }
      handler.dispose();
    });

    it('rejects pending IDs explicitly even though the channel is "live"', async () => {
      // Pending channels get registered in the live registries by
      // createPendingChannel. To exercise the explicit pending-prefix
      // gate (Phase 3 step 2), we directly create a channel under a
      // pending: ID, install an adapter so state !== 'unattached', and
      // assert the RPC rejects on the prefix check rather than the
      // tombstone check.
      const { createChannel, setAdapter } = await import('../src/core/session-channel.js');
      const pendingCh = createChannel('pending:test-1');
      const adapter = createMockAdapter({ vendor: 'claude' });
      setAdapter(pendingCh, adapter);
      await tick();
      // Channel state is now 'idle' (setAdapter sets it) and !tearing —
      // so the tombstone gate would NOT reject. The pending-prefix check
      // is the only thing that catches this.
      expect(pendingCh.state).not.toBe('unattached');
      expect(pendingCh.tearing).toBe(false);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'waitForIdle', {
        sessionId: 'pending:test-1',
      });
      expect(resp.kind).toBe('error');
      if (resp.kind === 'error') {
        expect(resp.error).toBe('Session not active: pending:test-1');
      }
      handler.dispose();
    });

    it('no caller subscription required to call waitForIdle', async () => {
      // Set up a session that someone ELSE is subscribed to.
      const s1 = makeSessionInfo({ sessionId: 'sess-wait-3', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const otherMessages: HostMessage[] = [];
      const otherHandler = createClientConnection('client-other', (m) => otherMessages.push(m));
      await sendRequestAndGetResponse(otherHandler, otherMessages, 'subscribe', { sessionId: 'sess-wait-3' });
      const adapter = lastCreated();

      // Fresh client, never called subscribe — calls waitForIdle.
      const { messages: callerMessages, sendFn } = createMockSend();
      const callerHandler = createClientConnection('client-caller', sendFn);

      const id = `req-waitForIdle-3`;
      const msgPromise = callerHandler.handleMessage({
        kind: 'request', id, method: 'waitForIdle', params: { sessionId: 'sess-wait-3' },
      });
      await tick();
      adapter.pushMessage({ type: 'event', event: { type: 'status', status: 'active' } });
      await tick();
      adapter.pushMessage({ type: 'event', event: { type: 'status', status: 'idle', turnComplete: true } });
      await msgPromise;

      const resp = callerMessages.find((m) => (m.kind === 'response' || m.kind === 'error') && m.id === id);
      expect(resp?.kind).toBe('response');
      if (resp?.kind === 'response') {
        expect(resp.result).toEqual({ reason: 'turnComplete' });
      }

      callerHandler.dispose();
      otherHandler.dispose();
    });
  });

  describe('readDialogue', () => {
    function buildHistory(turns: number): TranscriptEntry[] {
      const entries: TranscriptEntry[] = [];
      for (let i = 1; i <= turns; i++) {
        entries.push({ type: 'user', message: { role: 'user', content: `user-${i}` } });
        entries.push({ type: 'assistant', message: { role: 'assistant', content: `assistant-${i}` } });
      }
      return entries;
    }

    it('default range returns all turns', async () => {
      const entries = buildHistory(5);
      const s1 = makeSessionInfo({ sessionId: 'sess-dlg-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1], historyEntries: entries });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'readDialogue', { sessionId: 'sess-dlg-1' });
      expect(resp.kind).toBe('response');
      if (resp.kind === 'response') {
        const result = resp.result as { turns: { turn: number }[] };
        expect(result.turns.map(t => t.turn)).toEqual([1, 2, 3, 4, 5]);
      }
      handler.dispose();
    });

    it('from: -5 on a 10-turn transcript returns turns 6-10', async () => {
      const entries = buildHistory(10);
      const s1 = makeSessionInfo({ sessionId: 'sess-dlg-2', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1], historyEntries: entries });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'readDialogue', { sessionId: 'sess-dlg-2', from: -5 });
      if (resp.kind === 'response') {
        const result = resp.result as { turns: { turn: number }[] };
        expect(result.turns.map(t => t.turn)).toEqual([6, 7, 8, 9, 10]);
      } else { throw new Error(`unexpected error: ${resp.error}`); }
      handler.dispose();
    });

    it('from: -100 on a 10-turn transcript clamps to 1-10', async () => {
      const entries = buildHistory(10);
      const s1 = makeSessionInfo({ sessionId: 'sess-dlg-3', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1], historyEntries: entries });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'readDialogue', { sessionId: 'sess-dlg-3', from: -100 });
      if (resp.kind === 'response') {
        const result = resp.result as { turns: { turn: number }[] };
        expect(result.turns.map(t => t.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      } else { throw new Error(`unexpected error: ${resp.error}`); }
      handler.dispose();
    });

    it('from: -1, to: -1 returns the last turn only', async () => {
      const entries = buildHistory(10);
      const s1 = makeSessionInfo({ sessionId: 'sess-dlg-4', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1], historyEntries: entries });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'readDialogue', { sessionId: 'sess-dlg-4', from: -1, to: -1 });
      if (resp.kind === 'response') {
        const result = resp.result as { turns: { turn: number }[] };
        expect(result.turns.map(t => t.turn)).toEqual([10]);
      } else { throw new Error(`unexpected error: ${resp.error}`); }
      handler.dispose();
    });

    it('from: 3, to: 5 returns turns 3, 4, 5', async () => {
      const entries = buildHistory(10);
      const s1 = makeSessionInfo({ sessionId: 'sess-dlg-5', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1], historyEntries: entries });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'readDialogue', { sessionId: 'sess-dlg-5', from: 3, to: 5 });
      if (resp.kind === 'response') {
        const result = resp.result as { turns: { turn: number }[] };
        expect(result.turns.map(t => t.turn)).toEqual([3, 4, 5]);
      } else { throw new Error(`unexpected error: ${resp.error}`); }
      handler.dispose();
    });

    it('from: -3, to: -1 returns the last 3 turns', async () => {
      const entries = buildHistory(10);
      const s1 = makeSessionInfo({ sessionId: 'sess-dlg-6', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1], historyEntries: entries });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'readDialogue', { sessionId: 'sess-dlg-6', from: -3, to: -1 });
      if (resp.kind === 'response') {
        const result = resp.result as { turns: { turn: number }[] };
        expect(result.turns.map(t => t.turn)).toEqual([8, 9, 10]);
      } else { throw new Error(`unexpected error: ${resp.error}`); }
      handler.dispose();
    });

    it('positive range smoke test — wrapper shape and content', async () => {
      const entries = buildHistory(3);
      const s1 = makeSessionInfo({ sessionId: 'sess-dlg-7', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1], historyEntries: entries });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);
      const resp = await sendRequestAndGetResponse(handler, messages, 'readDialogue', { sessionId: 'sess-dlg-7', from: 1, to: 3 });
      if (resp.kind === 'response') {
        const result = resp.result as { turns: { turn: number; user: string; assistant: string }[] };
        // Wrapper preserved: result has a `turns` array (the rename
        // didn't accidentally drop the wrapper).
        expect(Array.isArray(result.turns)).toBe(true);
        expect(result.turns).toHaveLength(3);
        expect(result.turns[0]).toMatchObject({ turn: 1, user: 'user-1', assistant: 'assistant-1' });
        expect(result.turns[2]).toMatchObject({ turn: 3, user: 'user-3', assistant: 'assistant-3' });
      } else { throw new Error(`unexpected error: ${resp.error}`); }
      handler.dispose();
    });
  });

  describe('dispose', () => {
    it('cleans up all subscriptions on dispose', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createClientConnection('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });

      // Dispose should not throw
      expect(() => handler.dispose()).not.toThrow();

      // After dispose, events should no longer be forwarded
      const beforeCount = messages.length;
      lastCreated().pushMessage({
        type: 'entry',
        entry: { type: 'user', message: { role: 'user', content: 'after dispose' } },
      });
      await tick();

      const newEvents = messages.slice(beforeCount).filter((m) => m.kind === 'event');
      expect(newEvents).toHaveLength(0);
    });
  });
});
