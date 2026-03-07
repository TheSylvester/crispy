/**
 * Tests for opencode-agent-adapter.ts — Tier 3 (mock HTTP server, always run)
 *
 * Uses a mock OpenCode server on random port.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockOpenCodeServer, type MockOpenCodeServer } from './helpers/mock-opencode-server.js';
import { OpenCodeAgentAdapter } from '../src/core/adapters/opencode/opencode-agent-adapter.js';
import type { ChannelMessage } from '../src/core/agent-adapter.js';

let server: MockOpenCodeServer;

async function collectMessages(adapter: OpenCodeAgentAdapter, count: number, timeoutMs = 5000): Promise<ChannelMessage[]> {
  const messages: ChannelMessage[] = [];
  const iter = adapter.messages()[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  while (messages.length < count && Date.now() < deadline) {
    const result = await Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
      ),
    ]);
    if (result.done) break;
    messages.push(result.value);
  }

  return messages;
}

describe('OpenCodeAgentAdapter', () => {
  beforeEach(async () => {
    server = await createMockOpenCodeServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('starts server and creates session on sendTurn', async () => {
    const adapter = new OpenCodeAgentAdapter(
      { mode: 'fresh', cwd: '/tmp/test' },
      { cwd: '/tmp/test', baseUrl: server.baseUrl },
    );

    // Start collecting messages in background
    const messagesPromise = collectMessages(adapter, 3, 3000);

    // Send a turn
    adapter.sendTurn('Hello', {});

    // Wait for messages
    const messages = await messagesPromise;

    // Should have at least a session_changed event and active status
    const events = messages.filter((m) => m.type === 'event');
    expect(events.length).toBeGreaterThan(0);

    // Should have created session via POST
    const createReqs = server.requests.filter((r) => r.url.startsWith('/session') && !r.url.includes('/prompt'));
    expect(createReqs.length).toBeGreaterThan(0);

    adapter.close();
  });

  it('handles permission.updated → awaiting_approval', async () => {
    const adapter = new OpenCodeAgentAdapter(
      { mode: 'fresh', cwd: '/tmp/test' },
      { cwd: '/tmp/test', baseUrl: server.baseUrl },
    );

    // Start collecting
    const messagesPromise = collectMessages(adapter, 5, 3000);

    // Send a turn to connect SSE
    adapter.sendTurn('Run ls', {});

    // Wait for SSE to connect
    await new Promise((r) => setTimeout(r, 500));

    // Push a permission event
    server.pushSSE({
      type: 'permission.updated',
      properties: {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'mock-session-1',
        messageID: 'msg-1',
        title: 'Allow bash?',
        metadata: { command: 'ls' },
        time: { created: Date.now() / 1000 },
      },
    });

    const messages = await messagesPromise;

    // Should have an awaiting_approval event
    const approvalEvents = messages.filter(
      (m) => m.type === 'event' && 'status' in m.event && m.event.status === 'awaiting_approval',
    );
    expect(approvalEvents.length).toBeGreaterThan(0);

    adapter.close();
  });

  it('respondToApproval sends POST to permission endpoint', async () => {
    const adapter = new OpenCodeAgentAdapter(
      { mode: 'fresh', cwd: '/tmp/test' },
      { cwd: '/tmp/test', baseUrl: server.baseUrl },
    );

    const messagesPromise = collectMessages(adapter, 5, 3000);
    adapter.sendTurn('Test', {});
    await new Promise((r) => setTimeout(r, 500));

    // Push permission
    server.pushSSE({
      type: 'permission.updated',
      properties: {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'mock-session-1',
        messageID: 'msg-1',
        title: 'Allow?',
        metadata: {},
        time: { created: Date.now() / 1000 },
      },
    });

    await new Promise((r) => setTimeout(r, 300));

    // Respond to approval
    adapter.respondToApproval('perm-1', 'allow');

    await new Promise((r) => setTimeout(r, 300));

    // Check that a POST was made to permissions endpoint
    const permReqs = server.requests.filter((r) => r.url.includes('/permissions/'));
    expect(permReqs.length).toBeGreaterThan(0);
    expect(permReqs[0].body).toMatchObject({ response: 'once' });

    adapter.close();
    await messagesPromise;
  });

  it('interrupt sends POST to abort endpoint', async () => {
    const adapter = new OpenCodeAgentAdapter(
      { mode: 'fresh', cwd: '/tmp/test' },
      { cwd: '/tmp/test', baseUrl: server.baseUrl },
    );

    const messagesPromise = collectMessages(adapter, 3, 2000);
    adapter.sendTurn('Test', {});
    await new Promise((r) => setTimeout(r, 500));

    await adapter.interrupt();

    const abortReqs = server.requests.filter((r) => r.url.includes('/abort'));
    expect(abortReqs.length).toBeGreaterThan(0);

    adapter.close();
    await messagesPromise;
  });

  it('close rejects pending permissions and emits idle', async () => {
    const adapter = new OpenCodeAgentAdapter(
      { mode: 'fresh', cwd: '/tmp/test' },
      { cwd: '/tmp/test', baseUrl: server.baseUrl },
    );

    const messagesPromise = collectMessages(adapter, 10, 3000);
    adapter.sendTurn('Test', {});
    await new Promise((r) => setTimeout(r, 500));

    // Push permission
    server.pushSSE({
      type: 'permission.updated',
      properties: {
        id: 'perm-close',
        type: 'edit',
        sessionID: 'mock-session-1',
        messageID: 'msg-1',
        title: 'Allow edit?',
        metadata: {},
        time: { created: Date.now() / 1000 },
      },
    });

    await new Promise((r) => setTimeout(r, 300));

    // Close should reject pending permissions
    adapter.close();

    // Wait for async reject POST to arrive
    await new Promise((r) => setTimeout(r, 300));

    const messages = await messagesPromise;

    // Should end with idle status
    const lastStatusEvent = [...messages]
      .reverse()
      .find((m) => m.type === 'event' && 'status' in m.event);
    expect(lastStatusEvent).toBeDefined();

    // Should have posted reject
    const rejectReqs = server.requests.filter(
      (r) => r.url.includes('/permissions/') && (r.body as any)?.response === 'reject',
    );
    expect(rejectReqs.length).toBeGreaterThan(0);
  });

  it('handles session.idle → idle status', async () => {
    const adapter = new OpenCodeAgentAdapter(
      { mode: 'fresh', cwd: '/tmp/test' },
      { cwd: '/tmp/test', baseUrl: server.baseUrl },
    );

    const messagesPromise = collectMessages(adapter, 5, 3000);
    adapter.sendTurn('Test', {});
    await new Promise((r) => setTimeout(r, 500));

    server.pushSSE({
      type: 'session.idle',
      properties: { sessionID: 'mock-session-1' },
    });

    await new Promise((r) => setTimeout(r, 300));

    const messages = await messagesPromise;
    const idleEvents = messages.filter(
      (m) => m.type === 'event' && 'status' in m.event && m.event.status === 'idle',
    );
    expect(idleEvents.length).toBeGreaterThan(0);

    adapter.close();
  });

  it('handles message.part.updated → entry message', async () => {
    const adapter = new OpenCodeAgentAdapter(
      { mode: 'fresh', cwd: '/tmp/test' },
      { cwd: '/tmp/test', baseUrl: server.baseUrl },
    );

    const messagesPromise = collectMessages(adapter, 6, 3000);
    adapter.sendTurn('Test', {});
    await new Promise((r) => setTimeout(r, 500));

    // Push a text part update
    server.pushSSE({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          sessionID: 'mock-session-1',
          messageID: 'msg-1',
          type: 'text',
          text: 'Hello from OpenCode!',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 300));

    const messages = await messagesPromise;
    const entries = messages.filter((m) => m.type === 'entry');
    expect(entries.length).toBeGreaterThan(0);

    const textEntry = entries.find(
      (m) => m.type === 'entry' && m.entry.type === 'assistant',
    );
    expect(textEntry).toBeDefined();

    adapter.close();
  });

  it('settings are readable', () => {
    const adapter = new OpenCodeAgentAdapter(
      { mode: 'fresh', cwd: '/tmp/test', model: 'gpt-4o' },
      { cwd: '/tmp/test', baseUrl: server.baseUrl },
    );

    expect(adapter.vendor).toBe('opencode');
    expect(adapter.settings.vendor).toBe('opencode');
    expect(adapter.settings.model).toBe('gpt-4o');
    expect(adapter.status).toBe('idle');
    expect(adapter.contextUsage).toBeNull();

    adapter.close();
  });
});
