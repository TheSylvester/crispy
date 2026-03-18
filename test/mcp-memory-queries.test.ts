/**
 * Tests for pure query functions in memory-queries.ts.
 *
 * Tests listSessions against a temporary SQLite database with known test data.
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
import { listSessions } from '../src/mcp/memory-queries.js';

// ============================================================================
// Test Setup — isolated temp DB
// ============================================================================

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-queries-test-'));
  dbPath = join(testDir, 'crispy.db');
  // Initialize DB with schema
  getDb(dbPath);
});

afterEach(() => {
  _resetDb();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Helpers
// ============================================================================

function insertMessage(opts: {
  messageId: string;
  sessionId: string;
  seq: number;
  text: string;
  createdAt: number;  // epoch ms
}): void {
  const db = getDb(dbPath);
  db.run(
    `INSERT INTO messages (message_id, session_id, message_seq, message_text, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [opts.messageId, opts.sessionId, opts.seq, opts.text, opts.createdAt],
  );
}

function insertTitle(sessionId: string, title: string): void {
  const db = getDb(dbPath);
  db.run(
    `INSERT INTO session_titles (session_id, title, updated_at)
     VALUES (?, ?, ?)`,
    [sessionId, title, new Date().toISOString()],
  );
}

// ============================================================================
// listSessions
// ============================================================================

describe('listSessions', () => {
  it('groups by session_id and returns message count', () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    const t2 = new Date('2025-06-01T11:00:00Z').getTime();
    const t3 = new Date('2025-06-01T12:00:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'first prompt', createdAt: t1 });
    insertMessage({ messageId: 'a2', sessionId: 'sess-a', seq: 1, text: 'dark mode work', createdAt: t2 });
    insertMessage({ messageId: 'b1', sessionId: 'sess-b', seq: 0, text: 'another session', createdAt: t3 });

    const rows = listSessions(dbPath);

    expect(rows.length).toBe(2);
    // Most recent first
    expect(rows[0]!.session_id).toBe('sess-b');
    expect(rows[1]!.session_id).toBe('sess-a');
    expect(rows[1]!.message_count).toBe(2);
  });

  it('includes session titles when available', () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'hello', createdAt: t1 });
    insertTitle('sess-a', 'My Session Title');

    const rows = listSessions(dbPath);

    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe('My Session Title');
  });

  it('returns null title when no title set', () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'hello', createdAt: t1 });

    const rows = listSessions(dbPath);

    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBeNull();
  });

  it('filters by since parameter (ISO string converted to epoch ms)', () => {
    const old = new Date('2025-06-01T10:00:00Z').getTime();
    const recent = new Date('2025-06-02T10:00:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-old', seq: 0, text: 'old session', createdAt: old });
    insertMessage({ messageId: 'b1', sessionId: 'sess-new', seq: 0, text: 'new session', createdAt: recent });

    const rows = listSessions(dbPath, 50, '2025-06-02T00:00:00Z');
    expect(rows.length).toBe(1);
    expect(rows[0]!.session_id).toBe('sess-new');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      const t = new Date(`2025-06-0${i + 1}T10:00:00Z`).getTime();
      insertMessage({ messageId: `m${i}`, sessionId: `sess-${i}`, seq: 0, text: `session ${i}`, createdAt: t });
    }

    const rows = listSessions(dbPath, 3);
    expect(rows.length).toBe(3);
  });

  it('excludes specified session ID', () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    const t2 = new Date('2025-06-01T11:00:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'keep', createdAt: t1 });
    insertMessage({ messageId: 'b1', sessionId: 'sess-b', seq: 0, text: 'exclude', createdAt: t2 });

    const rows = listSessions(dbPath, 50, undefined, 'sess-b');
    expect(rows.length).toBe(1);
    expect(rows[0]!.session_id).toBe('sess-a');
  });

  it('returns first_activity and last_activity as epoch ms', () => {
    const t1 = new Date('2025-06-01T10:00:00Z').getTime();
    const t2 = new Date('2025-06-01T11:00:00Z').getTime();

    insertMessage({ messageId: 'a1', sessionId: 'sess-a', seq: 0, text: 'first', createdAt: t1 });
    insertMessage({ messageId: 'a2', sessionId: 'sess-a', seq: 1, text: 'second', createdAt: t2 });

    const rows = listSessions(dbPath);

    expect(rows[0]!.first_activity).toBe(t1);
    expect(rows[0]!.last_activity).toBe(t2);
  });
});
