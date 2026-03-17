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

function insertEntry(opts: {
  timestamp: string;
  kind: 'prompt' | 'rosie-meta';
  file: string;
  preview?: string;
  quest?: string;
  summary?: string;
  title?: string;
  status?: string;
  entities?: string;
}): void {
  const db = getDb(dbPath);
  db.run(
    `INSERT INTO session_meta (timestamp, kind, file, preview, quest, summary, title, status, entities)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.timestamp, opts.kind, opts.file,
      opts.preview ?? null, opts.quest ?? null, opts.summary ?? null,
      opts.title ?? null, opts.status ?? null, opts.entities ?? null,
    ],
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
    expect(names).toContain('search_sessions');
    expect(names).toContain('list_sessions');
    expect(names).toContain('session_context');
  });

  it('search_sessions returns matching results', async () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'implement authentication system',
      title: 'Auth System',
    });

    const { client } = await createConnectedClient();
    const result = await client.callTool({ name: 'search_sessions', arguments: { query: 'authentication' } });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].quest).toBe('implement authentication system');
  });

  it('list_sessions returns grouped sessions', async () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'prompt',
      file: '/sessions/a.jsonl',
      preview: 'hello',
    });
    insertEntry({
      timestamp: '2025-06-01T11:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'dark mode',
      title: 'Dark Mode',
    });

    const { client } = await createConnectedClient();
    const result = await client.callTool({ name: 'list_sessions', arguments: {} });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    expect(parsed.sessions[0].quest).toBe('dark mode');
  });

  it('session_context returns ordered entries', async () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'prompt',
      file: '/sessions/a.jsonl',
      preview: 'first',
    });
    insertEntry({
      timestamp: '2025-06-01T10:05:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'dark mode',
    });

    const { client } = await createConnectedClient();
    const result = await client.callTool({
      name: 'session_context',
      arguments: { file: '/sessions/a.jsonl' },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(2);
    expect(parsed.entries[0].kind).toBe('prompt');
    expect(parsed.entries[1].kind).toBe('rosie-meta');
  });
});

// ============================================================================
// Time-aware tool responses
// ============================================================================

describe('time-aware tool responses', () => {
  it('no footer during clean search phase (>30s remaining)', async () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'test query',
      title: 'Test',
    });

    // Deadline 60s from now — clean phase, no footer
    const { client } = await createConnectedClient({ deadlineMs: Date.now() + 60_000 });
    const result = await client.callTool({ name: 'search_sessions', arguments: { query: 'test' } });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();
  });

  it('returns isError when deadline has passed', async () => {
    // Deadline in the past
    const { client } = await createConnectedClient({ deadlineMs: Date.now() - 1000 });
    const result = await client.callTool({ name: 'search_sessions', arguments: { query: 'test' } });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toContain('TIME\'S UP');
  });

  it('no footer when deadlineMs is not set', async () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'test query',
      title: 'Test',
    });

    const { client } = await createConnectedClient();
    const result = await client.callTool({ name: 'search_sessions', arguments: { query: 'test' } });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();
  });

  it('shows time warning when deadline is close', async () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'warning test',
      title: 'Test',
    });

    // Deadline 20s from now — should show warning
    const { client } = await createConnectedClient({ deadlineMs: Date.now() + 20_000 });
    const result = await client.callTool({ name: 'search_sessions', arguments: { query: 'warning' } });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(2);
    expect(content[1]!.text).toMatch(/\[TIME WARNING\]/);
  });
});
