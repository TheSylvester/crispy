/**
 * Tests for pure query functions in memory-queries.ts.
 *
 * Tests searchSessions, listSessions, and sessionContext against
 * a temporary SQLite database with known test data.
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
import { searchSessions, listSessions, sessionContext } from '../src/mcp/memory-queries.js';

// ============================================================================
// Test Setup — isolated temp DB
// ============================================================================

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-queries-test-'));
  dbPath = join(testDir, 'crispy.db');
  // Initialize DB with all migrations (including FTS5 v7)
  getDb(dbPath);
});

afterEach(() => {
  _resetDb();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Helpers
// ============================================================================

function insertEntry(opts: {
  timestamp: string;
  kind: 'prompt' | 'rosie-meta';
  file: string;
  preview?: string;
  quest?: string;
  summary?: string;
  title?: string;
  status?: string;
}): void {
  const db = getDb(dbPath);
  db.run(
    `INSERT INTO session_meta (timestamp, kind, file, preview, quest, summary, title, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.timestamp, opts.kind, opts.file,
      opts.preview ?? null, opts.quest ?? null, opts.summary ?? null,
      opts.title ?? null, opts.status ?? null,
    ],
  );
}

// ============================================================================
// searchSessions
// ============================================================================

describe('searchSessions', () => {
  it('returns ranked results for matching query', () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'implement Rosie bot summarization',
      summary: 'added rosie-meta entries with quest and summary fields',
      title: 'Rosie Bot Setup',
    });
    insertEntry({
      timestamp: '2025-06-01T11:00:00Z',
      kind: 'prompt',
      file: '/sessions/b.jsonl',
      preview: 'Can you help with the rosie integration?',
    });

    const results = searchSessions(dbPath, 'rosie');
    expect(results.length).toBe(2);
    // rosie-meta entry should rank higher (quest + title + summary all match)
    expect(results[0]!.file).toBe('/sessions/a.jsonl');
  });

  it('filters by kind when specified', () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'database optimization',
      title: 'DB Perf',
    });
    insertEntry({
      timestamp: '2025-06-01T11:00:00Z',
      kind: 'prompt',
      file: '/sessions/b.jsonl',
      preview: 'optimize database queries',
    });

    const rosieOnly = searchSessions(dbPath, 'database', 20, 'rosie-meta');
    expect(rosieOnly.length).toBe(1);
    expect(rosieOnly[0]!.kind).toBe('rosie-meta');

    const promptOnly = searchSessions(dbPath, 'database', 20, 'prompt');
    expect(promptOnly.length).toBe(1);
    expect(promptOnly[0]!.kind).toBe('prompt');
  });

  it('returns empty array for empty query', () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'dark mode',
    });

    const results = searchSessions(dbPath, '  ');
    expect(results).toEqual([]);
  });

  it('returns empty results for no-match query', () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'implement dark mode',
    });

    const results = searchSessions(dbPath, 'authentication');
    expect(results.length).toBe(0);
  });

  it('supports Porter stemming (running matches run)', () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      summary: 'running the test suite successfully',
    });

    const results = searchSessions(dbPath, 'run');
    expect(results.length).toBe(1);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      insertEntry({
        timestamp: `2025-06-01T1${i}:00:00Z`,
        kind: 'rosie-meta',
        file: `/sessions/${i}.jsonl`,
        quest: `task number ${i} about testing`,
      });
    }

    const results = searchSessions(dbPath, 'testing', 3);
    expect(results.length).toBe(3);
  });
});

// ============================================================================
// listSessions
// ============================================================================

describe('listSessions', () => {
  it('groups by file and returns latest metadata', () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'prompt',
      file: '/sessions/a.jsonl',
      preview: 'first prompt',
    });
    insertEntry({
      timestamp: '2025-06-01T11:00:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'dark mode',
      title: 'Dark Mode',
      status: 'completed',
    });
    insertEntry({
      timestamp: '2025-06-01T12:00:00Z',
      kind: 'prompt',
      file: '/sessions/b.jsonl',
      preview: 'another session',
    });

    const rows = listSessions(dbPath);

    expect(rows.length).toBe(2);
    // Most recent first
    expect(rows[0]!.file).toBe('/sessions/b.jsonl');
    expect(rows[1]!.file).toBe('/sessions/a.jsonl');
    expect(rows[1]!.quest).toBe('dark mode');
    expect(rows[1]!.title).toBe('Dark Mode');
    expect(rows[1]!.status).toBe('completed');
    expect(rows[1]!.entry_count).toBe(2);
  });

  it('filters by since parameter', () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'prompt',
      file: '/sessions/old.jsonl',
      preview: 'old session',
    });
    insertEntry({
      timestamp: '2025-06-02T10:00:00Z',
      kind: 'prompt',
      file: '/sessions/new.jsonl',
      preview: 'new session',
    });

    const rows = listSessions(dbPath, 50, '2025-06-02T00:00:00Z');
    expect(rows.length).toBe(1);
    expect(rows[0]!.file).toBe('/sessions/new.jsonl');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      insertEntry({
        timestamp: `2025-06-0${i + 1}T10:00:00Z`,
        kind: 'prompt',
        file: `/sessions/${i}.jsonl`,
        preview: `session ${i}`,
      });
    }

    const rows = listSessions(dbPath, 3);
    expect(rows.length).toBe(3);
  });
});

// ============================================================================
// sessionContext
// ============================================================================

describe('sessionContext', () => {
  it('returns ordered entries for a session', () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'prompt',
      file: '/sessions/a.jsonl',
      preview: 'first prompt',
    });
    insertEntry({
      timestamp: '2025-06-01T10:05:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'dark mode',
      summary: 'user asked about dark mode',
    });
    insertEntry({
      timestamp: '2025-06-01T11:00:00Z',
      kind: 'prompt',
      file: '/sessions/b.jsonl',
      preview: 'different session',
    });

    const rows = sessionContext(dbPath, '/sessions/a.jsonl');

    expect(rows.length).toBe(2);
    expect(rows[0]!.kind).toBe('prompt');
    expect(rows[1]!.kind).toBe('rosie-meta');
    expect(rows[1]!.quest).toBe('dark mode');
  });

  it('filters by kind', () => {
    insertEntry({
      timestamp: '2025-06-01T10:00:00Z',
      kind: 'prompt',
      file: '/sessions/a.jsonl',
      preview: 'a prompt',
    });
    insertEntry({
      timestamp: '2025-06-01T10:05:00Z',
      kind: 'rosie-meta',
      file: '/sessions/a.jsonl',
      quest: 'dark mode',
    });

    const promptOnly = sessionContext(dbPath, '/sessions/a.jsonl', 'prompt');
    expect(promptOnly.length).toBe(1);
    expect(promptOnly[0]!.kind).toBe('prompt');
  });

  it('returns empty array for unknown file', () => {
    const rows = sessionContext(dbPath, '/sessions/nonexistent.jsonl');
    expect(rows).toEqual([]);
  });
});
