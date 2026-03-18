/**
 * Tests for the internal MCP server (servers/internal.ts).
 *
 * Instantiates the server and calls tools programmatically via the
 * MCP SDK's Client, without stdio. Verifies results against a temp DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

// Mock the rosie debug-log module to prevent the log persister from
// triggering a re-entrant getDb() call with the production DB path,
// which would close the test DB mid-migration.
vi.mock('../src/core/log.js', () => ({
  log: () => {},
  getLogSnapshot: () => [],
  subscribeLog: () => () => {},
  unsubscribeLog: () => {},
  registerLogPersister: () => {},
  LOG_CHANNEL_ID: 'log',
}));

import { getDb, _resetDb } from '../src/core/crispy-db.js';

// We need to mock getDbPath before importing the server
let testDir: string;
let dbPath: string;

vi.mock('../src/core/activity-index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    dbPath: () => dbPath,
    ensureCrispyDir: () => {},
  };
});

// Mock getDbPath to return our test DB path
vi.mock('../src/mcp/memory-queries.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getDbPath: () => dbPath,
  };
});

import { createInternalServer } from '../src/mcp/servers/internal.js';
import type { InternalServerOptions } from '../src/mcp/servers/internal.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(() => {
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-internal-test-'));
  dbPath = join(testDir, 'crispy.db');
  getDb(dbPath);
});

afterEach(() => {
  _resetDb();
  fs.rmSync(testDir, { recursive: true, force: true });
});

function insertMessage(opts: {
  messageId: string;
  sessionId: string;
  seq: number;
  text: string;
  createdAt: number;
}): void {
  const db = getDb(dbPath);
  db.run(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [opts.messageId, opts.sessionId, opts.seq, opts.text, opts.createdAt],
  );
}

async function createConnectedClient(options?: InternalServerOptions) {
  const server = createInternalServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return { client, server };
}

// ============================================================================
// Tests
// ============================================================================

describe('internal MCP server', () => {
  it('lists available tools', async () => {
    const { client } = await createConnectedClient();
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name);
    expect(names).toContain('list_sessions');
    expect(names).not.toContain('search_sessions');
    expect(names).not.toContain('session_context');
  });

  it('list_sessions returns grouped sessions from messages table', async () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    const t2 = new Date('2025-06-01T11:00:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'hello', createdAt: t1 });
    insertMessage({ messageId: 'a2', sessionId: 'sess-a', seq: 1, text: 'dark mode implementation', createdAt: t2 });

    const { client } = await createConnectedClient();
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    expect(parsed.sessions[0].message_count).toBe(2);
  });

  it('list_sessions excludes the caller session when excludeSessionId is set', async () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    const t2 = new Date('2025-06-01T11:00:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'caller session text', createdAt: t1 });
    insertMessage({ messageId: 'b1', sessionId: 'sess-b', seq: 0, text: 'other session text', createdAt: t2 });

    const { client } = await createConnectedClient({ excludeSessionId: 'sess-a' });
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].session_id).toBe('sess-b');
  });

  it('search_transcript excludes the caller session from results and session_hits', async () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    const t2 = new Date('2025-06-01T11:00:00Z').getTime();
    const t3 = new Date('2025-06-01T12:00:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'recall playground prompt tuning', createdAt: t1 });
    insertMessage({ messageId: 'a2', sessionId: 'sess-a', seq: 1, text: 'more recall playground work', createdAt: t2 });
    insertMessage({ messageId: 'b1', sessionId: 'sess-b', seq: 0, text: 'recall playground regression fix', createdAt: t3 });

    const { client } = await createConnectedClient({ excludeSessionId: 'sess-a' });
    const result = await client.callTool({
      name: 'search_transcript',
      arguments: { query: 'recall playground', all_projects: true },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    expect(parsed.total_matches).toBe(1);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].session_id).toBe('sess-b');
    expect(parsed.session_hits).toEqual({ 'sess-b': 1 });
  });

  it('read_message rejects direct reads of the excluded session', async () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    const t2 = new Date('2025-06-01T10:01:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'user prompt', createdAt: t1 });
    insertMessage({ messageId: 'a2', sessionId: 'sess-a', seq: 1, text: 'assistant reply', createdAt: t2 });

    const { client } = await createConnectedClient({ excludeSessionId: 'sess-a' });
    const result = await client.callTool({
      name: 'read_message',
      arguments: { session_id: 'sess-a', message_id: 'a1' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.found).toBe(false);
    expect(parsed.error).toContain('blocked');
  });

  it('read_session rejects direct reads of the excluded session', async () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    const t2 = new Date('2025-06-01T10:01:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'user prompt', createdAt: t1 });
    insertMessage({ messageId: 'a2', sessionId: 'sess-a', seq: 1, text: 'assistant reply', createdAt: t2 });

    const { client } = await createConnectedClient({ excludeSessionId: 'sess-a' });
    const result = await client.callTool({
      name: 'read_session',
      arguments: { session_id: 'sess-a', offset: 0, limit: 10 },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.found).toBe(false);
    expect(parsed.error).toContain('blocked');
  });
});

// ============================================================================
// Time-aware tool responses
// ============================================================================

describe('time-aware tool responses', () => {
  it('no footer during clean search phase (>30s remaining)', async () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    insertMessage({ messageId: 'm1', sessionId: 'sess-a', seq: 0, text: 'test query', createdAt: t1 });

    // Deadline 60s from now — clean phase, no footer
    const { client } = await createConnectedClient({ deadlineMs: Date.now() + 60_000 });
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();
  });

  it('returns isError when deadline has passed', async () => {
    // Deadline in the past
    const { client } = await createConnectedClient({ deadlineMs: Date.now() - 1000 });
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toContain('TIME\'S UP');
  });

  it('no footer when deadlineMs is not set', async () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    insertMessage({ messageId: 'm1', sessionId: 'sess-a', seq: 0, text: 'test query', createdAt: t1 });

    const { client } = await createConnectedClient();
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();
  });

  it('shows time warning when deadline is close', async () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    insertMessage({ messageId: 'm1', sessionId: 'sess-a', seq: 0, text: 'warning test', createdAt: t1 });

    // Deadline 20s from now — should show warning
    const { client } = await createConnectedClient({ deadlineMs: Date.now() + 20_000 });
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(2);
    expect(content[1]!.text).toMatch(/\[TIME WARNING\]/);
  });
});
