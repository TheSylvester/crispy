/**
 * Tests for Crispy Database Module
 *
 * Tests the SQLite singleton lifecycle, pragmas, migration runner,
 * and legacy data import.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

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
});

// ============================================================================
// Migrations
// ============================================================================

describe('migrations', () => {
  it('creates activity_entries table', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // Verify table exists by inserting and querying
    db.run(
      `INSERT INTO activity_entries (timestamp, kind, file, preview, byte_offset)
       VALUES (?, ?, ?, ?, ?)`,
      ['2025-01-01T00:00:00Z', 'prompt', '/test.jsonl', 'test', 0],
    );
    const row = db.get('SELECT COUNT(*) as cnt FROM activity_entries') as Record<string, unknown>;
    expect(row.cnt).toBe(1);
  });

  it('creates scan_state table', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    db.run(
      'INSERT INTO scan_state (file_path, mtime, size, byte_offset) VALUES (?, ?, ?, ?)',
      ['/test.jsonl', 1000, 500, 250],
    );
    const row = db.get('SELECT COUNT(*) as cnt FROM scan_state') as Record<string, unknown>;
    expect(row.cnt).toBe(1);
  });

  it('creates _migrations tracking table', () => {
    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const rows = db.all('SELECT version, description FROM _migrations ORDER BY version');
    expect(rows.length).toBe(2);
    expect((rows[0] as Record<string, unknown>).version).toBe(1);
    expect((rows[1] as Record<string, unknown>).version).toBe(2);
  });

  it('runs migrations idempotently', () => {
    const dbPath = join(testDir, 'crispy.db');

    // Open, close, reopen — migrations should not fail
    getDb(dbPath);
    _resetDb();
    getDb(dbPath);

    const db = getDb(dbPath);
    const rows = db.all('SELECT version FROM _migrations ORDER BY version');
    expect(rows.length).toBe(2);
  });
});

// ============================================================================
// Legacy Data Migration
// ============================================================================

describe('legacy migration', () => {
  it('imports existing JSONL data on first DB open', () => {
    const jsonlPath = join(testDir, 'activity-index.jsonl');
    const entries = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'First', offset: 0, uuid: 'msg-1' }),
      JSON.stringify({ timestamp: '2025-01-15T11:00:00Z', kind: 'prompt', file: '/b.jsonl', preview: 'Second', offset: 100 }),
    ];
    fs.writeFileSync(jsonlPath, entries.join('\n') + '\n');

    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // Data should be in the DB
    const rows = db.all('SELECT timestamp, file, preview, uuid FROM activity_entries ORDER BY timestamp');
    expect(rows.length).toBe(2);
    expect((rows[0] as Record<string, unknown>).preview).toBe('First');
    expect((rows[0] as Record<string, unknown>).uuid).toBe('msg-1');
    expect((rows[1] as Record<string, unknown>).preview).toBe('Second');
    expect((rows[1] as Record<string, unknown>).uuid).toBeNull();

    // JSONL should be renamed to .bak
    expect(fs.existsSync(jsonlPath)).toBe(false);
    expect(fs.existsSync(jsonlPath + '.bak')).toBe(true);
  });

  it('imports existing scan-state.json on first DB open', () => {
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

    const rows = db.all('SELECT file_path, mtime, size, byte_offset FROM scan_state ORDER BY file_path');
    expect(rows.length).toBe(2);
    expect((rows[0] as Record<string, unknown>).file_path).toBe('/a.jsonl');
    expect((rows[0] as Record<string, unknown>).byte_offset).toBe(25);

    // scan-state.json should be renamed to .bak
    expect(fs.existsSync(scanPath)).toBe(false);
    expect(fs.existsSync(scanPath + '.bak')).toBe(true);
  });

  it('skips malformed JSONL lines during migration', () => {
    const jsonlPath = join(testDir, 'activity-index.jsonl');
    const lines = [
      JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'Valid', offset: 0 }),
      '{ not valid json',
      JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', kind: 'prompt', file: '/c.jsonl', preview: 'Also valid', offset: 0 }),
    ];
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');

    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    const rows = db.all('SELECT preview FROM activity_entries ORDER BY timestamp');
    expect(rows.length).toBe(2);
    expect((rows[0] as Record<string, unknown>).preview).toBe('Valid');
    expect((rows[1] as Record<string, unknown>).preview).toBe('Also valid');
  });

  it('skips migration if .bak files already exist (idempotent)', () => {
    const jsonlPath = join(testDir, 'activity-index.jsonl');
    const bakPath = jsonlPath + '.bak';

    // Create both .jsonl and .bak — simulates a previous partial migration
    fs.writeFileSync(jsonlPath, JSON.stringify({ timestamp: '2025-01-15T10:00:00Z', kind: 'prompt', file: '/a.jsonl', preview: 'New', offset: 0 }) + '\n');
    fs.writeFileSync(bakPath, 'old backup');

    const dbPath = join(testDir, 'crispy.db');
    const db = getDb(dbPath);

    // The .jsonl should NOT have been imported (since .bak exists)
    const rows = db.all('SELECT * FROM activity_entries');
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
