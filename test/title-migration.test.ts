/**
 * Tests for the v5→v6 schema migration (rename-sessions plan §H.1).
 *
 * Validates that:
 *   - A v5 DB with `session_titles` rows is migrated to v6.
 *   - `session_kind` values move into `session_kinds`.
 *   - Non-empty titles stage into `pending_title_migration`.
 *   - Migrated titles seed `rosie_last_titles` (so Rosie's CAS doesn't
 *     classify them as "human renamed" on the first iteration).
 *   - `session_titles` is dropped after migration.
 *
 * The migration runs synchronously inside `getDb()` when the DB
 * already has `_migrations.version=5`. We seed a v5 DB, then re-open
 * to trigger the migration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { Database } from 'node-sqlite3-wasm';

import { _setTestDir } from '../src/core/activity-index.js';
import { getDb, _resetDb } from '../src/core/crispy-db.js';
import { dbPath } from '../src/core/paths.js';
import {
  registerAdapter,
  _resetRegistry,
} from '../src/core/session-manager.js';
import { _resetRegistry as _resetChannelRegistry } from '../src/core/session-channel.js';
import { runPendingTitleMigration } from '../src/core/migrations/retire-session-titles.js';
import type {
  AgentAdapter,
  AdapterSettings,
  SessionInfo,
  ChannelMessage,
  VendorDiscovery,
} from '../src/core/agent-adapter.js';
import type { ChannelStatus } from '../src/core/channel-events.js';
import type { Vendor } from '../src/core/transcript.js';
import { AsyncIterableQueue } from '../src/core/async-iterable-queue.js';

let testDir: string;
let cleanup: () => void;

beforeEach(() => {
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-migration-test-'));
  cleanup = _setTestDir(testDir);
  // _setTestDir opens a fresh DB at the v6 schema. Close and delete the file
  // so seedV5Db() can stamp a clean v5 layout from scratch.
  _resetDb();
  if (fs.existsSync(dbPath())) {
    fs.rmSync(dbPath(), { force: true });
  }
});

afterEach(() => {
  cleanup();
  fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/**
 * Stamp a minimal v5 schema with the tables our migration reads from
 * (session_titles + _migrations). We create just enough to look like a
 * pre-v6 DB; the migration's INSERT INTOs and DROP TABLE only care
 * about session_titles' columns.
 */
function seedV5Db(rows: Array<{ session_id: string; title: string; session_kind: string | null }>): void {
  const db = new Database(dbPath());
  db.exec(`
    CREATE TABLE _migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE session_titles (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      session_kind TEXT
    );
  `);
  // Mark v5 as the existing version.
  db.run('INSERT INTO _migrations (version, description) VALUES (5, ?)', ['legacy v5']);
  for (const r of rows) {
    db.run(
      'INSERT INTO session_titles (session_id, title, updated_at, session_kind) VALUES (?, ?, ?, ?)',
      [r.session_id, r.title, new Date().toISOString(), r.session_kind],
    );
  }
  db.close();
}

describe('v5→v6 schema migration', () => {
  it('drops session_titles and creates the three replacement tables', () => {
    seedV5Db([]);
    const db = getDb(dbPath());

    // session_titles is gone. (node-sqlite3-wasm returns null for "no row".)
    const hasOld = db.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='session_titles'`,
    );
    expect(hasOld).toBeFalsy();

    // The three new tables exist.
    const names = db
      .all(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_kinds','rosie_last_titles','pending_title_migration')`)
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(names).toEqual(['pending_title_migration', 'rosie_last_titles', 'session_kinds']);

    // Migration row recorded.
    const ver = db.get(`SELECT MAX(version) as v FROM _migrations`) as { v: number };
    expect(ver.v).toBe(6);
  });

  it('moves session_kind values into session_kinds', () => {
    seedV5Db([
      { session_id: 'sys-1', title: '', session_kind: 'system' },
      { session_id: 'usr-1', title: '', session_kind: 'user' },
      { session_id: 'plain', title: '', session_kind: null },
    ]);
    const db = getDb(dbPath());

    const kinds = db.all(`SELECT session_id, session_kind FROM session_kinds ORDER BY session_id`);
    expect(kinds).toEqual([
      { session_id: 'sys-1', session_kind: 'system' },
      { session_id: 'usr-1', session_kind: 'user' },
    ]);
  });

  it('stages non-empty titles into pending_title_migration', () => {
    seedV5Db([
      { session_id: 's1', title: 'First Title', session_kind: null },
      { session_id: 's2', title: 'Second Title', session_kind: null },
      { session_id: 'empty', title: '', session_kind: null },  // skipped — empty title
    ]);
    const db = getDb(dbPath());

    const pending = db
      .all(`SELECT session_id, title, attempts FROM pending_title_migration ORDER BY session_id`);
    expect(pending).toEqual([
      { session_id: 's1', title: 'First Title', attempts: 0 },
      { session_id: 's2', title: 'Second Title', attempts: 0 },
    ]);
  });

  it('seeds rosie_last_titles with the same titles', () => {
    seedV5Db([
      { session_id: 's1', title: 'Rosie Wrote This', session_kind: null },
      { session_id: 's2', title: 'And This', session_kind: null },
      { session_id: 'empty', title: '', session_kind: null },
    ]);
    const db = getDb(dbPath());

    // Without seeding, Rosie's first CAS would see vendor.title === migrated
    // value, vs rosie_last_titles[id] === null → classify as "human renamed"
    // and freeze every migrated title. The seed prevents that.
    const seeded = db
      .all(`SELECT session_id, title FROM rosie_last_titles ORDER BY session_id`);
    expect(seeded).toEqual([
      { session_id: 's1', title: 'Rosie Wrote This' },
      { session_id: 's2', title: 'And This' },
    ]);
  });

  it('is idempotent: re-running on a v6 DB is a no-op', () => {
    seedV5Db([
      { session_id: 's1', title: 'Title', session_kind: 'user' },
    ]);
    const db1 = getDb(dbPath());
    const initialPendingCount = (db1.all('SELECT COUNT(*) as c FROM pending_title_migration')[0] as { c: number }).c;
    expect(initialPendingCount).toBe(1);

    _resetDb();
    const db2 = getDb(dbPath());
    const finalPendingCount = (db2.all('SELECT COUNT(*) as c FROM pending_title_migration')[0] as { c: number }).c;
    // Same count — migration didn't double-stage anything.
    expect(finalPendingCount).toBe(1);

    // Version still 6 (the no-op `if (currentVersion === 5)` branch is skipped).
    const ver = db2.get(`SELECT MAX(version) as v FROM _migrations`) as { v: number };
    expect(ver.v).toBe(6);
  });

  it('fresh DB (no v5 stamp) creates v6 tables directly without staging anything', () => {
    // No seedV5Db — so getDb() runs the fresh-schema path, which creates
    // session_kinds, rosie_last_titles, pending_title_migration directly.
    const db = getDb(dbPath());

    const ver = db.get(`SELECT MAX(version) as v FROM _migrations`) as { v: number };
    expect(ver.v).toBe(6);

    const pendingCount = (db.all('SELECT COUNT(*) as c FROM pending_title_migration')[0] as { c: number }).c;
    expect(pendingCount).toBe(0);
  });
});

// ============================================================================
// Async data migration cold-cache pre-warm (rename-sessions plan §H.2)
// ============================================================================

function makeSessionInfo(id: string, vendor: Vendor): SessionInfo {
  return {
    sessionId: id,
    path: `/tmp/${id}.jsonl`,
    projectSlug: 'mock',
    modifiedAt: new Date(),
    size: 0,
    vendor,
  };
}

function dummyAdapter(vendor: Vendor): AgentAdapter {
  const queue = new AsyncIterableQueue<ChannelMessage>();
  let status: ChannelStatus = 'idle';
  return {
    vendor,
    get sessionId() { return undefined; },
    get status() { return status; },
    get contextUsage() { return null; },
    get settings(): AdapterSettings {
      return { vendor, model: undefined, permissionMode: undefined, allowDangerouslySkipPermissions: false, extraArgs: undefined };
    },
    messages: () => queue,
    sendTurn: vi.fn() as unknown as AgentAdapter['sendTurn'],
    respondToApproval: vi.fn(),
    close: vi.fn(() => { status = 'idle'; queue.done(); }),
    interrupt: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
  };
}

describe('runPendingTitleMigration — cold-cache pre-warm', () => {
  afterEach(() => {
    _resetRegistry();
    _resetChannelRegistry();
  });

  it('refreshes vendor caches before draining so cold Codex-style discoveries resolve', async () => {
    // Codex-style discovery: empty cache initially. findSession returns undefined
    // until refresh() populates the cache. Without the migration's pre-warm,
    // resolveTitleHandler would throw "No session found" on every row and
    // the migration would increment attempts toward MAX_ATTEMPTS.
    seedV5Db([
      { session_id: 'cold-1', title: 'Frozen Title', session_kind: null },
    ]);
    // Trigger v5→v6 migration so pending_title_migration is populated.
    getDb(dbPath());

    const titleStore = new Map<string, string>();
    let cachePopulated = false;
    const sess = makeSessionInfo('cold-1', 'codex');

    const discovery: VendorDiscovery = {
      vendor: 'codex',
      findSession: (id: string) => (cachePopulated && id === 'cold-1' ? sess : undefined),
      listSessions: () => (cachePopulated ? [sess] : []),
      loadHistory: async () => [],
      refresh: vi.fn(async () => {
        cachePopulated = true;
      }),
      setSessionTitle: vi.fn(async (id: string, title: string) => {
        titleStore.set(id, title);
      }),
      getSessionTitle: vi.fn(async (id: string) => titleStore.get(id) ?? null),
    };
    registerAdapter(discovery, () => dummyAdapter('codex'));

    const result = await runPendingTitleMigration();
    expect(discovery.refresh).toHaveBeenCalled();
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(titleStore.get('cold-1')).toBe('Frozen Title');

    // Pending row drained.
    const remaining = getDb(dbPath()).all(
      'SELECT session_id FROM pending_title_migration',
    );
    expect(remaining).toEqual([]);
  });
});
