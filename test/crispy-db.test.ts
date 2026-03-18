/**
 * Tests for Crispy Database Module
 *
 * Tests the SQLite singleton lifecycle, pragmas, schema creation,
 * and FTS5 support.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

// Mock the rosie debug-log module to prevent the log persister (registered
// as a module-level side effect in activity-index.ts) from triggering a
// re-entrant getDb() call with the production DB path during migrations.
vi.mock('../src/core/log.js', () => ({
  log: () => {},
  getLogSnapshot: () => [],
  subscribeLog: () => () => {},
  unsubscribeLog: () => {},
  registerLogPersister: () => {},
  LOG_CHANNEL_ID: 'log',
}));

import { getDb, closeDb, _resetDb } from '../src/core/crispy-db.js';

// ============================================================================
// Test Setup
// ============================================================================

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-db-test-'));
});

afterEach(() => {
  _resetDb();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Database Lifecycle
// ============================================================================

describe('getDb', () => {
  it('creates database file on first open', () => {
    const dbPath = join(testDir, 'crispy.db');
    expect(fs.existsSync(dbPath)).toBe(false);

    getDb(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('returns same instance on repeated calls with same path', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db1 = getDb(dbPath);
    const db2 = getDb(dbPath);
    expect(db1).toBe(db2);
  });

  it('sets busy_timeout pragma', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);
    const row = db.get('PRAGMA busy_timeout') as Record<string, unknown>;
    // node-sqlite3-wasm returns { timeout: N } for PRAGMA busy_timeout
    expect(row.timeout).toBe(5000);
  });

  it('does NOT use WAL mode (WASM limitation)', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);
    const row = db.get('PRAGMA journal_mode') as Record<string, unknown>;
    // WASM SQLite cannot do WAL — file-based DBs use 'delete' (rollback journal)
    expect(row.journal_mode).toBe('delete');
  });

  it('enables foreign key enforcement', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);
    const row = db.get('PRAGMA foreign_keys') as Record<string, unknown>;
    expect(row.foreign_keys).toBe(1);
  });
});

// ============================================================================
// Schema
// ============================================================================

describe('schema', () => {
  it('creates session_meta table with correct columns', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // Verify table exists by inserting and querying
    db.run(
      `INSERT INTO session_meta (ts, kind, file, preview)
       VALUES (?, ?, ?, ?)`,
      ['2025-01-01T00:00:00Z', 'prompt', '/test.jsonl', 'test'],
    );
    const row = db.get('SELECT COUNT(*) as cnt FROM session_meta') as Record<string, unknown>;
    expect(row.cnt).toBe(1);
  });

  it('session_meta has session_id, model, cwd columns', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    db.run(
      `INSERT INTO session_meta (ts, kind, file, preview, session_id, model, cwd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['2025-01-01T00:00:00Z', 'prompt', '/test.jsonl', 'test', 'sess-123', 'haiku', '/home/user'],
    );
    const row = db.get('SELECT session_id, model, cwd FROM session_meta') as Record<string, unknown>;
    expect(row.session_id).toBe('sess-123');
    expect(row.model).toBe('haiku');
    expect(row.cwd).toBe('/home/user');
  });

  it('creates _migrations tracking table with version 1', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const rows = db.all('SELECT version FROM _migrations ORDER BY version') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.version).toBe(1);
  });

  it('runs schema idempotently', () => {
    const dbPath = join(testDir, 'crispy.db');

    // Open, close, reopen — schema should not fail
    getDb(dbPath);
    _resetDb();
    getDb(dbPath);

    const db = getDb(dbPath);
    const rows = db.all('SELECT version FROM _migrations ORDER BY version');
    expect(rows.length).toBe(1);
  });

  it('creates all 19 regular tables', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const tables = db.all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ) as Array<{ name: string }>;
    const tableNames = new Set(tables.map(r => r.name));

    const expected = [
      '_migrations', 'session_meta', 'session_lineage', 'session_titles',
      'projects', 'project_sessions', 'project_files', 'project_activity', 'stages',
      'messages', 'message_vectors',
      'file_mutations', 'commit_index', 'commit_file_changes',
      'provenance_scan_state', 'provenance_repo_state',
      'event_log', 'rosie_usage', 'tracker_outcomes',
    ];

    for (const t of expected) {
      expect(tableNames.has(t), `table ${t} should exist`).toBe(true);
    }
  });

  it('creates 3 FTS5 virtual tables', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const fts = db.all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts' ORDER BY name`
    ) as Array<{ name: string }>;
    const names = fts.map(r => r.name);

    expect(names).toContain('session_meta_fts');
    expect(names).toContain('messages_fts');
    expect(names).toContain('commit_fts');
  });

  it('seeds 8 stage rows', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const rows = db.all('SELECT name FROM stages ORDER BY sort_order') as Array<{ name: string }>;
    expect(rows.length).toBe(8);
    expect(rows.map(r => r.name)).toEqual([
      'idea', 'planning', 'ready', 'active', 'paused', 'committed', 'done', 'archived',
    ]);
  });
});

// ============================================================================
// FTS5 Support
// ============================================================================

describe('FTS5 support', () => {
  it('supports FTS5 virtual tables', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // Create an FTS5 table — verifies FTS5 is compiled into the WASM build
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS test_fts USING fts5(content)');
    db.run("INSERT INTO test_fts (content) VALUES (?)", ['hello world']);
    db.run("INSERT INTO test_fts (content) VALUES (?)", ['goodbye world']);

    const rows = db.all("SELECT * FROM test_fts WHERE test_fts MATCH 'hello'");
    expect(rows.length).toBe(1);
    expect((rows[0] as Record<string, unknown>).content).toBe('hello world');
  });
});

// ============================================================================
// FTS5 — session_meta_fts
// ============================================================================

describe('session_meta_fts', () => {
  it('creates the session_meta_fts virtual table', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const row = db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='session_meta_fts'",
    ) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('session_meta_fts');
  });

  it('syncs FTS5 on INSERT into session_meta', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    db.run(
      `INSERT INTO session_meta (ts, kind, file, preview)
       VALUES (?, ?, ?, ?)`,
      ['2025-06-01T10:00:00Z', 'prompt', '/test.jsonl', 'added dark theme support'],
    );

    const rows = db.all("SELECT * FROM session_meta_fts WHERE session_meta_fts MATCH 'dark'");
    expect(rows.length).toBe(1);
  });

  it('supports Porter stemming (running matches run)', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    db.run(
      `INSERT INTO session_meta (ts, kind, file, preview)
       VALUES (?, ?, ?, ?)`,
      ['2025-06-01T10:00:00Z', 'prompt', '/test.jsonl', 'running the test suite'],
    );

    const rows = db.all("SELECT * FROM session_meta_fts WHERE session_meta_fts MATCH 'run'");
    expect(rows.length).toBe(1);
  });
});

// ============================================================================
// closeDb
// ============================================================================

describe('closeDb', () => {
  it('closes the database connection', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);
    expect(db.isOpen).toBe(true);

    closeDb();

    // Getting a new DB should return a different instance
    const db2 = getDb(dbPath);
    expect(db2.isOpen).toBe(true);
    expect(db2).not.toBe(db);
  });
});

// ============================================================================
// message_vectors CASCADE
// ============================================================================

describe('message_vectors ON DELETE CASCADE', () => {
  function seedSession(db: import('node-sqlite3-wasm').Database, sessionId: string, count: number) {
    for (let i = 0; i < count; i++) {
      const mid = `${sessionId}-msg-${i}`;
      db.run(
        `INSERT INTO messages (message_id, session_id, message_seq, message_text, project_id, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
        [mid, sessionId, i, `text ${i}`, Date.now()],
      );
      db.run(
        `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale)
         VALUES (?, ?, ?, ?)`,
        [mid, Buffer.alloc(8), 1.0, 0.5],
      );
    }
  }

  it('cascades vector deletes when parent messages are deleted', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    seedSession(db, 'sess-a', 3);

    // Verify vectors exist
    const before = db.get('SELECT COUNT(*) as cnt FROM message_vectors') as Record<string, unknown>;
    expect(before.cnt).toBe(3);

    // Delete messages — CASCADE should remove vectors
    db.run("DELETE FROM messages WHERE session_id = 'sess-a'");

    const after = db.get('SELECT COUNT(*) as cnt FROM message_vectors') as Record<string, unknown>;
    expect(after.cnt).toBe(0);
  });

  it('with FK ON, inserting a vector with no parent message fails', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    expect(() => {
      db.run(
        `INSERT INTO message_vectors (message_id, embedding_q8, norm, quant_scale)
         VALUES (?, ?, ?, ?)`,
        ['orphan-no-parent', Buffer.alloc(8), 1.0, 0.5],
      );
    }).toThrow();
  });

  it('only cascades vectors for the deleted session', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    seedSession(db, 'sess-a', 2);
    seedSession(db, 'sess-b', 3);

    db.run("DELETE FROM messages WHERE session_id = 'sess-a'");

    const remaining = db.get('SELECT COUNT(*) as cnt FROM message_vectors') as Record<string, unknown>;
    expect(remaining.cnt).toBe(3);
  });
});
