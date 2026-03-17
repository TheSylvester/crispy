/**
 * Tests for Crispy Database Module
 *
 * Tests the SQLite singleton lifecycle, pragmas, migration runner,
 * and legacy data import.
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
// Migrations
// ============================================================================

describe('migrations', () => {
  it('creates session_meta table', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // Verify table exists by inserting and querying
    db.run(
      `INSERT INTO session_meta (timestamp, kind, file, preview, byte_offset)
       VALUES (?, ?, ?, ?, ?)`,
      ['2025-01-01T00:00:00Z', 'rosie-meta', '/test.jsonl', 'test', 0],
    );
    const row = db.get('SELECT COUNT(*) as cnt FROM session_meta') as Record<string, unknown>;
    expect(row.cnt).toBe(1);
  });

  it('drops scan_state table in migration v19', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const row = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='scan_state'") as Record<string, unknown> | null;
    expect(row).toBeNull();
  });

  it('creates _migrations tracking table', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const rows = db.all('SELECT version FROM _migrations ORDER BY version') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(24);
    const versions = rows.map(r => r.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });

  it('runs migrations idempotently', () => {
    const dbPath = join(testDir, 'crispy.db');

    // Open, close, reopen — migrations should not fail
    getDb(dbPath);
    _resetDb();
    getDb(dbPath);

    const db = getDb(dbPath);
    const rows = db.all('SELECT version FROM _migrations ORDER BY version');
    expect(rows.length).toBe(24);
  });
});

// ============================================================================
// Legacy Data Migration
// ============================================================================

describe('legacy migration', () => {
  it('imports existing JSONL data on first DB open', () => {
    const jsonlPath = join(testDir, 'activity-index.jsonl');
    const entries = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'rosie-meta', file: '/a.jsonl', preview: 'First', offset: 0, uuid: 'msg-1' }),
      JSON.stringify({ timestamp: '2025-01-15T11:00:00Z', kind: 'rosie-meta', file: '/b.jsonl', preview: 'Second', offset: 100 }),
    ];
    fs.writeFileSync(jsonlPath, entries.join('\n') + '\n');

    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // Data should be in the DB (migrated to session_meta, prompt rows purged by v19)
    const rows = db.all('SELECT timestamp, file, preview, uuid FROM session_meta ORDER BY timestamp');
    expect(rows.length).toBe(2);
    expect((rows[0] as Record<string, unknown>).preview).toBe('First');
    expect((rows[0] as Record<string, unknown>).uuid).toBe('msg-1');
    expect((rows[1] as Record<string, unknown>).preview).toBe('Second');
    expect((rows[1] as Record<string, unknown>).uuid).toBeNull();

    // JSONL should be renamed to .bak
    expect(fs.existsSync(jsonlPath)).toBe(false);
    expect(fs.existsSync(jsonlPath + '.bak')).toBe(true);
  });

  it('imports existing scan-state.json on first DB open (then drops scan_state in v19)', () => {
    const scanPath = join(testDir, 'scan-state.json');
    const scanState = {
      version: 1,
      files: {
        '/a.jsonl': { mtime: 100, size: 50, offset: 25 },
        '/b.jsonl': { mtime: 200, size: 100, offset: 75 },
      },
    };
    fs.writeFileSync(scanPath, JSON.stringify(scanState));

    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // scan_state table is dropped by v19 — verify it no longer exists
    const tableExists = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='scan_state'") as Record<string, unknown> | null;
    expect(tableExists).toBeNull();

    // scan-state.json should be renamed to .bak (migration v2 runs before v19)
    expect(fs.existsSync(scanPath)).toBe(false);
    expect(fs.existsSync(scanPath + '.bak')).toBe(true);
  });

  it('skips malformed JSONL lines during migration', () => {
    const jsonlPath = join(testDir, 'activity-index.jsonl');
    const lines = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'rosie-meta', file: '/a.jsonl', preview: 'Valid', offset: 0 }),
      '{ not valid json',
      JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', kind: 'rosie-meta', file: '/c.jsonl', preview: 'Also valid', offset: 0 }),
    ];
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');

    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const rows = db.all('SELECT preview FROM session_meta ORDER BY timestamp');
    expect(rows.length).toBe(2);
    expect((rows[0] as Record<string, unknown>).preview).toBe('Valid');
    expect((rows[1] as Record<string, unknown>).preview).toBe('Also valid');
  });

  it('skips migration if .bak files already exist (idempotent)', () => {
    const jsonlPath = join(testDir, 'activity-index.jsonl');
    const bakPath = jsonlPath + '.bak';

    // Create both .jsonl and .bak — simulates a previous partial migration
    fs.writeFileSync(jsonlPath, JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'rosie-meta', file: '/a.jsonl', preview: 'New', offset: 0 }) + '\n');
    fs.writeFileSync(bakPath, 'old backup');

    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // The .jsonl should NOT have been imported (since .bak exists)
    const rows = db.all('SELECT * FROM session_meta');
    expect(rows.length).toBe(0);

    // Original .jsonl should still exist (not renamed)
    expect(fs.existsSync(jsonlPath)).toBe(true);
    expect(fs.existsSync(bakPath)).toBe(true);
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
// FTS5 Migration (v7) — session_meta_fts
// ============================================================================

describe('FTS5 session_meta_fts (migration v7)', () => {
  it('creates the session_meta_fts virtual table', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // Verify table exists by querying sqlite_master
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
      `INSERT INTO session_meta (timestamp, kind, file, preview, quest, summary, title)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['2025-06-01T10:00:00Z', 'rosie-meta', '/test.jsonl', 'test preview',
       'implement dark mode', 'added dark theme support', 'Dark Mode'],
    );

    const rows = db.all("SELECT * FROM session_meta_fts WHERE session_meta_fts MATCH 'dark'");
    expect(rows.length).toBe(1);
  });

  it('returns BM25-ranked results ordered by relevance', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // Insert entries with varying relevance to "authentication"
    db.run(
      `INSERT INTO session_meta (timestamp, kind, file, preview, quest, summary, title)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['2025-06-01T10:00:00Z', 'rosie-meta', '/a.jsonl', 'some preview',
       'implement authentication', 'set up auth flow', 'Authentication Setup'],
    );
    db.run(
      `INSERT INTO session_meta (timestamp, kind, file, preview, quest, summary, title)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['2025-06-01T11:00:00Z', 'prompt', '/b.jsonl',
       'mentioned authentication in passing', null, null, null],
    );

    const rows = db.all(`
      SELECT ae.id, bm25(session_meta_fts) as rank
      FROM session_meta_fts
      JOIN session_meta ae ON ae.id = session_meta_fts.rowid
      WHERE session_meta_fts MATCH 'authentication'
      ORDER BY rank
    `) as Array<Record<string, unknown>>;

    expect(rows.length).toBe(2);
    // First result should have better (more negative) rank due to quest+title+summary matches
    expect(rows[0]!.rank as number).toBeLessThan(rows[1]!.rank as number);
  });

  it('supports Porter stemming (running matches run)', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    db.run(
      `INSERT INTO session_meta (timestamp, kind, file, summary)
       VALUES (?, ?, ?, ?)`,
      ['2025-06-01T10:00:00Z', 'rosie-meta', '/test.jsonl', 'running the test suite'],
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
// message_vectors CASCADE (migration v15)
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

  it('migration v15 would fail with orphaned vectors (regression proof)', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // With FK ON, inserting a vector with no parent message fails
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
