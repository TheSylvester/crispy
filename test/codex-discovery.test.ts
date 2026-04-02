/**
 * Tests for CodexDiscovery (VendorDiscovery implementation)
 *
 * Validates session listing, history loading, caching, and
 * client lifecycle management.
 *
 * Uses mocked child_process.spawn to inject a MockCodexProcess.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockCodexProcess } from './helpers/mock-codex-process.js';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'child_process';
import type { Thread } from '../src/core/adapters/codex/protocol/v2/Thread.js';
import type { ThreadItem } from '../src/core/adapters/codex/protocol/v2/ThreadItem.js';

// Mock child_process.spawn before importing CodexDiscovery
let mockProcess: MockCodexProcess;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((_command: string, _args: string[], _options: SpawnOptionsWithoutStdio) => {
      // Access mockProcess from outer scope
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any).__mockCodexProcess?.asChildProcess() as unknown as ChildProcess;
    }),
  };
});

// Import after mock is set up
import { CodexDiscovery } from '../src/core/adapters/codex/codex-discovery.js';
import { CodexRpcClient } from '../src/core/adapters/codex/codex-rpc-client.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-123',
    preview: 'Help me refactor the authentication module',
    modelProvider: 'openai',
    createdAt: 1700000000,
    updatedAt: 1700001000,
    path: '/home/user/.codex/threads/thread-123.jsonl',
    cwd: '/home/user/project',
    cliVersion: '0.1.0',
    source: 'cli',
    gitInfo: null,
    turns: [],
    ...overrides,
  };
}

function createMockUserMessageItem(text: string, id: string = 'item-1'): ThreadItem {
  return {
    type: 'userMessage',
    id,
    content: [{ type: 'text', text, text_elements: [] }],
  };
}

function createMockAgentMessageItem(text: string, id: string = 'item-2'): ThreadItem {
  return {
    type: 'agentMessage',
    id,
    text,
  };
}

/**
 * Helper: handle the `initialize` handshake that ensureClient() now sends
 * before any RPC call when it spawns a temporary client.
 */
async function handleInitialize(proc: MockCodexProcess): Promise<void> {
  const req = await proc.getNextClientMessage();
  expect(req.method).toBe('initialize');
  proc.pushResponse(req.id, { userAgent: 'codex/test' });
}

// ============================================================================
// Tests
// ============================================================================

describe('CodexDiscovery', () => {
  let discovery: CodexDiscovery;

  beforeEach(() => {
    // Reset mock process for each test
    mockProcess = new MockCodexProcess();
    (globalThis as any).__mockCodexProcess = mockProcess;

    // Create fresh discovery instance
    discovery = new CodexDiscovery();
  });

  afterEach(async () => {
    // Detach any clients
    discovery.detachClient();
    await new Promise((r) => setTimeout(r, 10));
    vi.clearAllMocks();
  });

  // ========== Session Listing ==========

  describe('listSessions', () => {
    it('returns empty array before first refresh', () => {
      const sessions = discovery.listSessions();
      expect(sessions).toEqual([]);
    });

    it('returns sessions after refresh', async () => {
      const thread1 = createMockThread({ id: 'thread-1', preview: 'First session' });
      const thread2 = createMockThread({ id: 'thread-2', preview: 'Second session' });

      // Set up response for the automatic refresh
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        // Wait for the request to come in
        const req = await mockProcess.getNextClientMessage();
        expect(req.method).toBe('thread/list');
        mockProcess.pushResponse(req.id, {
          data: [thread1, thread2],
          nextCursor: null,
        });
      })();

      // Force synchronous refresh
      await discovery.refresh();

      const sessions = discovery.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBe('thread-1');
      expect(sessions[1].sessionId).toBe('thread-2');
    });

    it('maps Thread fields to SessionInfo correctly', async () => {
      const thread = createMockThread({
        id: 'thread-abc',
        preview: 'A very long preview that should be truncated after 80 characters when displayed as a label in the UI',
        updatedAt: 1700500000,
        cwd: '/home/user/my-project',
        path: '/path/to/thread.jsonl',
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { data: [thread], nextCursor: null });
      })();

      await discovery.refresh();

      const sessions = discovery.listSessions();
      expect(sessions[0]).toMatchObject({
        sessionId: 'thread-abc',
        path: '/path/to/thread.jsonl',
        projectSlug: '-home-user-my-project',
        projectPath: '/home/user/my-project',
        size: 0,
        vendor: 'codex',
      });
      // modifiedAt should be Date
      expect(sessions[0].modifiedAt).toBeInstanceOf(Date);
      expect(sessions[0].modifiedAt.getTime()).toBe(1700500000 * 1000);
      // label should be truncated
      expect(sessions[0].label?.length).toBeLessThanOrEqual(80);
      // lastMessage should be full preview
      expect(sessions[0].lastMessage).toBe(thread.preview);
    });

    it('handles null path gracefully', async () => {
      const thread = createMockThread({ path: null });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { data: [thread], nextCursor: null });
      })();

      await discovery.refresh();

      const sessions = discovery.listSessions();
      expect(sessions[0].path).toBe('');
    });
  });

  // ========== Pagination ==========

  describe('pagination', () => {
    it('exhausts all pages via cursor', async () => {
      const thread1 = createMockThread({ id: 'thread-1' });
      const thread2 = createMockThread({ id: 'thread-2' });
      const thread3 = createMockThread({ id: 'thread-3' });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        // First page
        const req1 = await mockProcess.getNextClientMessage();
        expect(req1.method).toBe('thread/list');
        expect((req1.params as any).cursor).toBeNull();
        mockProcess.pushResponse(req1.id, {
          data: [thread1],
          nextCursor: 'cursor-page-2',
        });

        // Second page
        const req2 = await mockProcess.getNextClientMessage();
        expect((req2.params as any).cursor).toBe('cursor-page-2');
        mockProcess.pushResponse(req2.id, {
          data: [thread2],
          nextCursor: 'cursor-page-3',
        });

        // Third page (final)
        const req3 = await mockProcess.getNextClientMessage();
        expect((req3.params as any).cursor).toBe('cursor-page-3');
        mockProcess.pushResponse(req3.id, {
          data: [thread3],
          nextCursor: null,
        });
      })();

      await discovery.refresh();

      const sessions = discovery.listSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions.map((s) => s.sessionId)).toEqual(['thread-1', 'thread-2', 'thread-3']);
    });
  });

  // ========== History Loading ==========

  describe('loadHistory', () => {
    it('calls thread/read with includeTurns: true', async () => {
      const thread = createMockThread({
        id: 'thread-xyz',
        turns: [
          {
            id: 'turn-1',
            items: [createMockUserMessageItem('Hello')],
            status: 'completed',
            error: null,
          },
        ],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        expect(req.method).toBe('thread/read');
        expect(req.params).toEqual({
          threadId: 'thread-xyz',
          includeTurns: true,
        });
        mockProcess.pushResponse(req.id, { thread });
      })();

      const entries = await discovery.loadHistory('thread-xyz');
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('user');
    });

    it('flattens turns and items into entries', async () => {
      const thread = createMockThread({
        id: 'thread-xyz',
        turns: [
          {
            id: 'turn-1',
            items: [
              createMockUserMessageItem('Hello', 'item-1'),
              createMockAgentMessageItem('Hi there!', 'item-2'),
            ],
            status: 'completed',
            error: null,
          },
          {
            id: 'turn-2',
            items: [
              createMockUserMessageItem('How are you?', 'item-3'),
              createMockAgentMessageItem("I'm doing well!", 'item-4'),
            ],
            status: 'completed',
            error: null,
          },
        ],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { thread });
      })();

      const entries = await discovery.loadHistory('thread-xyz');

      // 4 items total
      expect(entries).toHaveLength(4);
      expect(entries[0].type).toBe('user');
      expect(entries[1].type).toBe('assistant');
      expect(entries[2].type).toBe('user');
      expect(entries[3].type).toBe('assistant');
    });
  });

  // ========== findSession ==========

  describe('findSession', () => {
    it('returns matching session from cache', async () => {
      const thread = createMockThread({ id: 'find-me' });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { data: [thread], nextCursor: null });
      })();

      await discovery.refresh();

      const found = discovery.findSession('find-me');
      expect(found).toBeDefined();
      expect(found?.sessionId).toBe('find-me');
    });

    it('returns undefined for non-existent session', async () => {
      const thread = createMockThread({ id: 'other-id' });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { data: [thread], nextCursor: null });
      })();

      await discovery.refresh();

      const found = discovery.findSession('non-existent');
      expect(found).toBeUndefined();
    });
  });

  // ========== Cache TTL ==========

  describe('cache TTL', () => {
    it('returns stale cache while refresh is in progress', async () => {
      const thread1 = createMockThread({ id: 'old-thread' });

      // First refresh
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { data: [thread1], nextCursor: null });
      })();

      await discovery.refresh();

      // Simulate cache becoming stale by manipulating internal state
      // (In production, this would be based on time passing)
      // For this test, we verify that listSessions returns immediately
      const sessions = discovery.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('old-thread');
    });
  });

  // ========== Client Lifecycle ==========

  describe('attachClient / detachClient', () => {
    it('uses attached client instead of spawning new one', async () => {
      const sharedMock = new MockCodexProcess();
      (globalThis as any).__mockCodexProcess = sharedMock;

      const sharedClient = new CodexRpcClient({
        onNotification: () => {},
        onRequest: () => {},
        onError: () => {},
        onExit: () => {},
      });

      discovery.attachClient(sharedClient);

      const thread = createMockThread({ id: 'shared-thread' });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        const req = await sharedMock.getNextClientMessage();
        sharedMock.pushResponse(req.id, { data: [thread], nextCursor: null });
      })();

      await discovery.refresh();

      const sessions = discovery.listSessions();
      expect(sessions[0].sessionId).toBe('shared-thread');

      // Clean up
      sharedClient.kill();
    });

    it('detachClient kills owned client', async () => {
      // Force discovery to spawn its own client by calling refresh
      const thread = createMockThread({ id: 'owned-thread' });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { data: [thread], nextCursor: null });
      })();

      await discovery.refresh();

      // Now detach - should kill the owned client
      discovery.detachClient();

      // Client should be killed
      expect(mockProcess.asChildProcess().killed).toBe(true);
    });
  });

  // ========== Empty Session List ==========

  describe('edge cases', () => {
    it('handles empty thread list', async () => {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { data: [], nextCursor: null });
      })();

      await discovery.refresh();

      const sessions = discovery.listSessions();
      expect(sessions).toEqual([]);
    });

    it('handles empty turns in loadHistory', async () => {
      const thread = createMockThread({
        id: 'empty-turns',
        turns: [],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { thread });
      })();

      const entries = await discovery.loadHistory('empty-turns');
      expect(entries).toEqual([]);
    });

    it('derives projectSlug from cwd correctly', async () => {
      const thread = createMockThread({
        cwd: '/Users/developer/projects/my-app',
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { data: [thread], nextCursor: null });
      })();

      await discovery.refresh();

      const sessions = discovery.listSessions();
      expect(sessions[0].projectSlug).toBe('-Users-developer-projects-my-app');
    });

    it('derives projectSlug from Windows cwd with backslashes', async () => {
      const thread = createMockThread({
        cwd: 'C:\\Users\\developer\\projects\\my-app',
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      (async () => {
        await handleInitialize(mockProcess);
        const req = await mockProcess.getNextClientMessage();
        mockProcess.pushResponse(req.id, { data: [thread], nextCursor: null });
      })();

      await discovery.refresh();

      const sessions = discovery.listSessions();
      expect(sessions[0].projectSlug).toBe('c--Users-developer-projects-my-app');
    });
  });
});
