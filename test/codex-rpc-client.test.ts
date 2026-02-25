/**
 * Tests for CodexRpcClient (JSON-RPC over stdin/stdout)
 *
 * Validates request/response correlation, notification routing,
 * server request handling, error responses, timeouts, and process lifecycle.
 *
 * Uses mocked child_process.spawn to inject a MockCodexProcess.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockCodexProcess } from './helpers/mock-codex-process.js';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'child_process';

// Mock child_process.spawn before importing CodexRpcClient
let mockProcess: MockCodexProcess;
let capturedSpawnCalls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
      capturedSpawnCalls.push({ command, args, options });
      // Access mockProcess from outer scope - it will be set before each test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any).__mockCodexProcess?.asChildProcess() as unknown as ChildProcess;
    }),
  };
});

// Import after mock is set up
import { CodexRpcClient, type CodexRpcClientOptions } from '../src/core/adapters/codex/codex-rpc-client.js';

describe('CodexRpcClient', () => {
  let client: CodexRpcClient;
  const notifications: Array<{ method: string; params: unknown }> = [];
  const serverRequests: Array<{ method: string; id: number | string; params: unknown }> = [];
  const errors: Error[] = [];
  const exits: Array<{ code: number | null; signal: string | null }> = [];

  function createClient(overrides: Partial<CodexRpcClientOptions> = {}): CodexRpcClient {
    return new CodexRpcClient({
      cwd: '/tmp/test',
      onNotification: (method, params) => {
        notifications.push({ method, params });
      },
      onRequest: (method, id, params) => {
        serverRequests.push({ method, id, params });
      },
      onError: (error) => {
        errors.push(error);
      },
      onExit: (code, signal) => {
        exits.push({ code, signal });
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    // Reset mock process for each test
    mockProcess = new MockCodexProcess();
    (globalThis as any).__mockCodexProcess = mockProcess;
    capturedSpawnCalls = [];
    notifications.length = 0;
    serverRequests.length = 0;
    errors.length = 0;
    exits.length = 0;

    client = createClient();
  });

  afterEach(async () => {
    // Kill the client if it's still running
    // Wrap in try-catch to ignore any pending request rejections
    try {
      client?.kill();
      // Give time for any pending rejections to settle
      await new Promise(r => setTimeout(r, 10));
    } catch {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  // ========== Group 1: Request/Response ==========

  describe('Request/Response correlation', () => {
    it('correlates response to pending request', async () => {
      // Start the request
      const resultPromise = client.request('test/method', { foo: 'bar' });

      // Get what was sent
      const sent = await mockProcess.getNextClientMessage();
      expect(sent.method).toBe('test/method');
      expect(sent.params).toEqual({ foo: 'bar' });
      expect(typeof sent.id).toBe('number');

      // Push matching response
      mockProcess.pushResponse(sent.id, { success: true });

      // Verify resolved value
      const result = await resultPromise;
      expect(result).toEqual({ success: true });
    });

    it('handles multiple concurrent requests', async () => {
      // Send 3 requests
      const p1 = client.request('method/a', { n: 1 });
      const p2 = client.request('method/b', { n: 2 });
      const p3 = client.request('method/c', { n: 3 });

      // Get all sent messages
      const sent1 = await mockProcess.getNextClientMessage();
      const sent2 = await mockProcess.getNextClientMessage();
      const sent3 = await mockProcess.getNextClientMessage();

      // Respond out of order (3, 1, 2)
      mockProcess.pushResponse(sent3.id, { result: 'c' });
      mockProcess.pushResponse(sent1.id, { result: 'a' });
      mockProcess.pushResponse(sent2.id, { result: 'b' });

      // Verify correct correlation
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toEqual({ result: 'a' });
      expect(r2).toEqual({ result: 'b' });
      expect(r3).toEqual({ result: 'c' });
    });

    it('includes jsonrpc version in requests', async () => {
      const p = client.request('test/method', {});
      const sent = await mockProcess.getNextClientMessage();
      expect(sent.jsonrpc).toBe('2.0');
      // Respond to complete the request
      mockProcess.pushResponse(sent.id, { ok: true });
      await p;
    });

    it('increments request IDs', async () => {
      const p1 = client.request('method/1', {});
      const p2 = client.request('method/2', {});

      const sent1 = await mockProcess.getNextClientMessage();
      const sent2 = await mockProcess.getNextClientMessage();

      expect(sent2.id).toBeGreaterThan(sent1.id as number);

      // Respond to complete the requests
      mockProcess.pushResponse(sent1.id, { ok: true });
      mockProcess.pushResponse(sent2.id, { ok: true });
      await Promise.all([p1, p2]);
    });
  });

  // ========== Group 2: Error Handling ==========

  describe('Error handling', () => {
    it('rejects on error response', async () => {
      const resultPromise = client.request('test/method', {});
      const sent = await mockProcess.getNextClientMessage();

      mockProcess.pushError(sent.id, -32600, 'Invalid request');

      await expect(resultPromise).rejects.toThrow(/RPC error.*-32600.*Invalid request/);
    });

    it('rejects on timeout', async () => {
      // Create a separate mock process for this test
      const timeoutMock = new MockCodexProcess();
      (globalThis as any).__mockCodexProcess = timeoutMock;

      // Create client with short timeout
      const shortTimeoutClient = createClient({ requestTimeoutMs: 50 });
      const resultPromise = shortTimeoutClient.request('slow/method', {});
      await timeoutMock.getNextClientMessage();

      // Don't respond - let it timeout
      await expect(resultPromise).rejects.toThrow(/timed out/i);

      // Reset global mock process back
      (globalThis as any).__mockCodexProcess = mockProcess;
      shortTimeoutClient.kill();
    }, 1000);

    it('rejects pending requests on process exit', async () => {
      const resultPromise = client.request('test/method', {});
      await mockProcess.getNextClientMessage();

      // Simulate process exit
      mockProcess.exit(1);

      await expect(resultPromise).rejects.toThrow(/exit|Process/i);
    });

    it('rejects new requests after process exit', async () => {
      mockProcess.exit(0);

      // Small delay to let exit event propagate
      await new Promise(r => setTimeout(r, 10));

      await expect(client.request('test/method', {})).rejects.toThrow(/not running|Process/i);
    });
  });

  // ========== Group 3: Notifications ==========

  describe('Notification routing', () => {
    it('routes server notifications to callback', async () => {
      mockProcess.pushNotification('item/started', { itemId: 'test-123' });
      mockProcess.pushNotification('item/completed', { itemId: 'test-123', result: 'ok' });

      // Small delay for async processing
      await new Promise(r => setTimeout(r, 10));

      expect(notifications).toHaveLength(2);
      expect(notifications[0]).toEqual({
        method: 'item/started',
        params: { itemId: 'test-123' },
      });
      expect(notifications[1]).toEqual({
        method: 'item/completed',
        params: { itemId: 'test-123', result: 'ok' },
      });
    });

    it('handles notifications without params', async () => {
      mockProcess.pushNotification('ping', undefined);

      await new Promise(r => setTimeout(r, 10));

      expect(notifications).toHaveLength(1);
      expect(notifications[0].method).toBe('ping');
    });
  });

  // ========== Group 4: Server Requests ==========

  describe('Server request handling', () => {
    it('routes server requests to callback', async () => {
      mockProcess.pushServerRequest('client/approve', 'srv-1', { toolUseId: 'tu-123' });

      await new Promise(r => setTimeout(r, 10));

      expect(serverRequests).toHaveLength(1);
      expect(serverRequests[0]).toEqual({
        method: 'client/approve',
        id: 'srv-1',
        params: { toolUseId: 'tu-123' },
      });
    });

    it('sends response to server request', async () => {
      // Client can send responses back
      client.sendResponse('srv-1', { approved: true });

      const sent = await mockProcess.getNextClientMessage();

      // Response message should have id and result
      expect(sent.id).toBe('srv-1');
    });
  });

  // ========== Group 5: Buffer Handling ==========

  describe('Buffer handling', () => {
    it('handles split JSON lines', async () => {
      const resultPromise = client.request('test/method', {});
      const sent = await mockProcess.getNextClientMessage();

      // Push response in two chunks
      const response = JSON.stringify({ id: sent.id, result: { ok: true } });
      const midpoint = Math.floor(response.length / 2);

      mockProcess.pushRaw(response.slice(0, midpoint));
      // Small delay
      await new Promise(r => setTimeout(r, 5));
      mockProcess.pushRaw(response.slice(midpoint) + '\n');

      const result = await resultPromise;
      expect(result).toEqual({ ok: true });
    });

    it('handles multiple JSON objects in single chunk', async () => {
      mockProcess.pushNotification('event/a', { n: 1 });
      mockProcess.pushNotification('event/b', { n: 2 });

      await new Promise(r => setTimeout(r, 10));

      expect(notifications).toHaveLength(2);
    });
  });

  // ========== Group 6: Process Lifecycle ==========

  describe('Process lifecycle', () => {
    it('kill() terminates the process', () => {
      expect(client.alive).toBe(true);

      client.kill();

      // After kill, client should report not alive
      // (Note: actual killed state depends on mock implementation)
      expect(mockProcess.asChildProcess().killed).toBe(true);
    });

    it('kill() is idempotent', () => {
      client.kill();
      client.kill(); // Should not throw

      expect(mockProcess.asChildProcess().killed).toBe(true);
    });

    it('reports alive status correctly', () => {
      expect(client.alive).toBe(true);

      mockProcess.exit(0);

      // Small delay for event propagation
      setTimeout(() => {
        expect(client.alive).toBe(false);
      }, 10);
    });

    it('calls onExit callback when process exits', async () => {
      mockProcess.exit(42);

      await new Promise(r => setTimeout(r, 10));

      expect(exits).toHaveLength(1);
      expect(exits[0].code).toBe(42);
    });
  });

  // ========== Group 7: Initialization ==========

  describe('Initialization and options', () => {
    it('uses default command and args', () => {
      // capturedSpawnCalls[0] is from the beforeEach createClient()
      expect(capturedSpawnCalls).toHaveLength(1);
      expect(capturedSpawnCalls[0].command).toBe('codex');
      expect(capturedSpawnCalls[0].args).toEqual(['app-server']);
    });

    it('accepts custom command and args', () => {
      // Clear and reset mock
      capturedSpawnCalls = [];
      mockProcess = new MockCodexProcess();
      (globalThis as any).__mockCodexProcess = mockProcess;

      const customClient = new CodexRpcClient({
        command: 'custom-codex',
        args: ['--mode', 'test'],
        cwd: '/custom/path',
        onNotification: () => {},
        onRequest: () => {},
        onError: () => {},
        onExit: () => {},
      });

      expect(capturedSpawnCalls).toHaveLength(1);
      expect(capturedSpawnCalls[0].command).toBe('custom-codex');
      expect(capturedSpawnCalls[0].args).toEqual(['--mode', 'test']);
      expect(capturedSpawnCalls[0].options.cwd).toBe('/custom/path');

      customClient.kill();
    });

    it('merges custom env with process.env', () => {
      // Clear and reset mock
      capturedSpawnCalls = [];
      mockProcess = new MockCodexProcess();
      (globalThis as any).__mockCodexProcess = mockProcess;

      const customClient = new CodexRpcClient({
        cwd: '/tmp',
        env: { CUSTOM_VAR: 'test-value' },
        onNotification: () => {},
        onRequest: () => {},
        onError: () => {},
        onExit: () => {},
      });

      expect(capturedSpawnCalls).toHaveLength(1);
      expect(capturedSpawnCalls[0].command).toBe('codex');
      expect(capturedSpawnCalls[0].args).toEqual(['app-server']);
      expect(capturedSpawnCalls[0].options.env).toMatchObject({ CUSTOM_VAR: 'test-value' });

      customClient.kill();
    });
  });
});
