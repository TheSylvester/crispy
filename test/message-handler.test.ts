/**
 * Tests for Message Handler — Client->Host request routing
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

import {
  createMessageHandler,
  type HostMessage,
} from '../src/host/message-handler.js';

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
  handler: ReturnType<typeof createMessageHandler>,
  sendMessages: HostMessage[],
  method: string,
  params?: Record<string, unknown>,
): Promise<HostMessage> {
  const id = `test-${method}-${Date.now()}`;
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

describe('MessageHandler', () => {
  describe('listSessions', () => {
    it('returns all sessions from registered adapters', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const s2 = makeSessionInfo({ sessionId: 'sess-2', vendor: 'claude', modifiedAt: new Date('2025-06-01') });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1, s2] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createMessageHandler('client-1', sendFn);

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
      const handler = createMessageHandler('client-1', sendFn);

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
      const handler = createMessageHandler('client-1', sendFn);

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
      const handler = createMessageHandler('client-1', sendFn);

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
      const handler = createMessageHandler('client-1', sendFn);

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
      const handler = createMessageHandler('client-1', sendFn);

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
  });

  describe('unsubscribe', () => {
    it('stops receiving events after unsubscribe', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createMessageHandler('client-1', sendFn);

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

  describe('send', () => {
    it('sends a message to a subscribed session', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createMessageHandler('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });

      const resp = await sendRequestAndGetResponse(handler, messages, 'send', {
        sessionId: 'sess-1',
        content: 'Hello world',
      });
      expect(resp.kind).toBe('response');
      expect(lastCreated().send).toHaveBeenCalledWith('Hello world');

      handler.dispose();
    });

    it('returns error when session has no open channel', async () => {
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createMessageHandler('client-1', sendFn);

      const resp = await sendRequestAndGetResponse(handler, messages, 'send', {
        sessionId: 'nonexistent',
        content: 'hello',
      });
      expect(resp.kind).toBe('error');

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
      const handler = createMessageHandler('client-1', sendFn);

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
      expect(lastCreated().respondToApproval).toHaveBeenCalledWith('tool-1', 'allow');

      handler.dispose();
    });

    it('errors when not subscribed', async () => {
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createMessageHandler('client-1', sendFn);

      const resp = await sendRequestAndGetResponse(handler, messages, 'resolveApproval', {
        sessionId: 'sess-1',
        toolUseId: 'tool-1',
        optionId: 'allow',
      });
      expect(resp.kind).toBe('error');

      handler.dispose();
    });
  });

  describe('setModel', () => {
    it('delegates to adapter.setModel()', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createMessageHandler('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });

      const resp = await sendRequestAndGetResponse(handler, messages, 'setModel', {
        sessionId: 'sess-1',
        model: 'opus',
      });
      expect(resp.kind).toBe('response');
      expect(lastCreated().setModel).toHaveBeenCalledWith('opus');

      handler.dispose();
    });
  });

  describe('setPermissions', () => {
    it('delegates to adapter.setPermissionMode()', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createMessageHandler('client-1', sendFn);

      await sendRequestAndGetResponse(handler, messages, 'subscribe', { sessionId: 'sess-1' });

      const resp = await sendRequestAndGetResponse(handler, messages, 'setPermissions', {
        sessionId: 'sess-1',
        mode: 'acceptEdits',
      });
      expect(resp.kind).toBe('response');
      expect(lastCreated().setPermissionMode).toHaveBeenCalledWith('acceptEdits');

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
      const handler = createMessageHandler('client-1', sendFn);

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
      const handler = createMessageHandler('client-1', sendFn);

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
      const handler = createMessageHandler('client-1', sendFn);

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
      const handler = createMessageHandler('client-1', sendFn);

      await handler.handleMessage({ kind: 'not-a-request', id: '1', method: 'listSessions' });
      expect(messages).toHaveLength(0);

      handler.dispose();
    });

    it('handles string messages (JSON parsing)', async () => {
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [] });
      registerAdapter(discovery, () => createMockAdapter({ vendor: 'claude' }));

      const { messages, sendFn } = createMockSend();
      const handler = createMessageHandler('client-1', sendFn);

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

  describe('dispose', () => {
    it('cleans up all subscriptions on dispose', async () => {
      const s1 = makeSessionInfo({ sessionId: 'sess-1', vendor: 'claude' });
      const discovery = createMockDiscovery({ vendor: 'claude', sessions: [s1] });
      const { factory, lastCreated } = createCapturingFactory({ vendor: 'claude' });
      registerAdapter(discovery, factory);

      const { messages, sendFn } = createMockSend();
      const handler = createMessageHandler('client-1', sendFn);

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
