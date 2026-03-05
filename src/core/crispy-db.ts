/**
 * Crispy Database — SQLite Singleton via node-sqlite3-wasm
 *
 * Owns the Database instance lifecycle: lazy init, pragmas, migrations,
 * and clean shutdown. activity-index.ts and session-lineage consumers.
 *
 * Uses node-sqlite3-wasm (pure WASM, no native binaries) to avoid
 * Electron ABI mismatches that killed better-sqlite3 in dev.8.
 *
 * WAL mode is NOT available in WASM SQLite (no mmap for shared memory).
 * Concurrent access works via rollback journal + busy_timeout.
 *
 * @module crispy-db
 */

import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { Database } from 'node-sqlite3-wasm';

// ============================================================================
// Singleton
// ============================================================================

let db: Database | null = null;
let currentDbPath: string | null = null;

/**
 * Get or create the SQLite database singleton.
 *
 * On first call, opens the database file (creating it if needed),
 * sets concurrency pragmas, and runs any pending migrations.
 * Subsequent calls return the cached instance if the path matches.
 */
export function getDb(dbPath: string): Database {
  if (db && currentDbPath === dbPath) return db;

  // Close any existing connection before opening a new one
  if (db) {
    closeDb();
  }

  db = new Database(dbPath);
  currentDbPath = dbPath;

  // Concurrency: wait up to 5s if another process holds the lock
  db.exec('PRAGMA busy_timeout = 5000');

  // Explicit rollback journal (WAL unavailable in WASM — silently falls
  // back to delete anyway, but be clear about intent)
  db.exec('PRAGMA journal_mode = DELETE');

  runMigrations(db, dbPath);

  return db;
}

/**
 * Close the database connection and release the singleton.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    currentDbPath = null;
  }
}

/**
 * Reset for testing — closes the DB so _setTestDir() can redirect.
 */
export function _resetDb(): void {
  closeDb();
}

// ============================================================================
// Migrations
// ============================================================================

interface Migration {
  version: number;
  description: string;
  up: (db: Database, dbPath: string) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create activity_entries and scan_state tables',
    up: (db: Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS activity_entries (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp   TEXT NOT NULL,
          kind        TEXT NOT NULL CHECK (kind IN ('prompt', 'rosie-meta')),
          file        TEXT NOT NULL,
          preview     TEXT,
          byte_offset INTEGER DEFAULT 0,
          uuid        TEXT,
          quest       TEXT,
          summary     TEXT,
          title       TEXT,
          UNIQUE (timestamp, file, uuid)
        );

        CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_entries(timestamp);
        CREATE INDEX IF NOT EXISTS idx_activity_kind ON activity_entries(kind);
        CREATE INDEX IF NOT EXISTS idx_activity_file ON activity_entries(file);

        CREATE TABLE IF NOT EXISTS scan_state (
          file_path   TEXT PRIMARY KEY,
          mtime       INTEGER NOT NULL,
          size        INTEGER NOT NULL,
          byte_offset INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  {
    version: 2,
    description: 'Migrate legacy JSONL/JSON data',
    up: (db: Database, dbPath: string): void => {
      const dir = dirname(dbPath);
      const jsonlPath = join(dir, 'activity-index.jsonl');
      const jsonlBak = jsonlPath + '.bak';
      const scanPath = join(dir, 'scan-state.json');
      const scanBak = scanPath + '.bak';

      // Import activity-index.jsonl if it exists and hasn't been migrated.
      // No nested BEGIN/COMMIT — the migration runner already wraps us in a transaction.
      if (fs.existsSync(jsonlPath) && !fs.existsSync(jsonlBak)) {
        try {
          const content = fs.readFileSync(jsonlPath, 'utf-8');
          const lines = content.split('\n').filter((l) => l.trim() !== '');

          if (lines.length > 0) {
            const stmt = db.prepare(
              `INSERT OR IGNORE INTO activity_entries
               (timestamp, kind, file, preview, byte_offset, uuid, quest, summary, title)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            try {
              for (const line of lines) {
                try {
                  const e = JSON.parse(line);
                  if (
                    typeof e.timestamp === 'string' &&
                    typeof e.file === 'string' &&
                    typeof e.preview === 'string'
                  ) {
                    stmt.run([
                      e.timestamp,
                      e.kind ?? 'prompt',
                      e.file,
                      e.preview,
                      e.offset ?? 0,
                      e.uuid ?? null,
                      e.quest ?? null,
                      e.summary ?? null,
                      e.title ?? null,
                    ]);
                  }
                } catch {
                  // Skip malformed lines
                }
              }
            } finally {
              stmt.finalize();
            }
          }

          fs.renameSync(jsonlPath, jsonlBak);
        } catch (err) {
          // If rename fails, log but don't block startup
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[crispy-db] Legacy JSONL migration warning:', err);
          }
        }
      }

      // Import scan-state.json if it exists and hasn't been migrated.
      // No nested BEGIN/COMMIT — the migration runner already wraps us in a transaction.
      if (fs.existsSync(scanPath) && !fs.existsSync(scanBak)) {
        try {
          const content = fs.readFileSync(scanPath, 'utf-8');
          const parsed = JSON.parse(content);

          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            parsed.version === 1 &&
            typeof parsed.files === 'object' &&
            parsed.files !== null
          ) {
            const stmt = db.prepare(
              'INSERT OR REPLACE INTO scan_state (file_path, mtime, size, byte_offset) VALUES (?, ?, ?, ?)',
            );
            try {
              for (const [path, s] of Object.entries(parsed.files)) {
                const state = s as { mtime: number; size: number; offset: number };
                stmt.run([path, state.mtime, state.size, state.offset]);
              }
            } finally {
              stmt.finalize();
            }
          }

          fs.renameSync(scanPath, scanBak);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[crispy-db] Legacy scan-state migration warning:', err);
          }
        }
      }
    },
  },
  {
    version: 3,
    description: 'Create session_lineage table and backfill fork dedup',
    up: (db: Database): void => {
      // Create the lineage tracking table
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_lineage (
          session_file      TEXT PRIMARY KEY,
          parent_file       TEXT,
          fork_point_uuid   TEXT,
          fork_point_offset INTEGER NOT NULL DEFAULT 0,
          created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_lineage_parent
          ON session_lineage(parent_file);
      `);

      // Backfill: detect existing fork pairs by shared UUIDs and timestamps.
      // For each pair of files sharing a UUID, the one with fewer total rows
      // (or scanned later) is treated as the child. We pick the file with the
      // lower rowid for the earliest matching entry as the parent.
      //
      // Step 1: Find fork relationships. Group by shared non-null UUIDs
      // across different files. For each pair, the file whose first entry has
      // the lower id is the parent (it was indexed first).
      const forkPairs = db.all(`
        SELECT
          a1.file AS file_a,
          a2.file AS file_b,
          MIN(a1.id) AS first_id_a,
          MIN(a2.id) AS first_id_b,
          COUNT(*) AS shared_count
        FROM activity_entries a1
        JOIN activity_entries a2
          ON a1.uuid = a2.uuid
          AND a1.file < a2.file
          AND a1.uuid IS NOT NULL
        GROUP BY a1.file, a2.file
        HAVING shared_count >= 1
      `) as Array<Record<string, unknown>>;

      for (const pair of forkPairs) {
        const fileA = pair.file_a as string;
        const fileB = pair.file_b as string;
        const firstIdA = pair.first_id_a as number;
        const firstIdB = pair.first_id_b as number;

        // Parent = whichever file was indexed first (lower first row id)
        const parentFile = firstIdA <= firstIdB ? fileA : fileB;
        const childFile = parentFile === fileA ? fileB : fileA;

        // Find the last shared UUID (the fork point)
        const forkRow = db.get(`
          SELECT a1.uuid, a1.byte_offset
          FROM activity_entries a1
          JOIN activity_entries a2
            ON a1.uuid = a2.uuid
            AND a1.uuid IS NOT NULL
          WHERE a1.file = ? AND a2.file = ?
          ORDER BY a1.byte_offset DESC
          LIMIT 1
        `, [childFile, parentFile]) as Record<string, unknown> | undefined;

        const forkPointUuid = forkRow?.uuid as string | null ?? null;
        const forkPointOffset = forkRow?.byte_offset as number ?? 0;

        // Insert lineage record (ignore if already exists from a prior pair)
        db.run(
          `INSERT OR IGNORE INTO session_lineage
           (session_file, parent_file, fork_point_uuid, fork_point_offset)
           VALUES (?, ?, ?, ?)`,
          [childFile, parentFile, forkPointUuid, forkPointOffset],
        );

        // Delete duplicate entries from the child file for the shared prefix.
        // Keep the parent's entries, remove the child's entries that share UUIDs.
        db.run(`
          DELETE FROM activity_entries
          WHERE file = ?
            AND uuid IS NOT NULL
            AND uuid IN (
              SELECT uuid FROM activity_entries
              WHERE file = ? AND uuid IS NOT NULL
            )
        `, [childFile, parentFile]);
      }
    },
  },
  {
    version: 4,
    description: 'Backfill fork pairs missed by v3 (shared_count = 1)',
    up: (db: Database): void => {
      // v3 used HAVING shared_count >= 2, missing single-shared-UUID forks.
      // Re-run the same logic with >= 1 for any remaining duplicates.
      // INSERT OR IGNORE ensures already-recorded lineage from v3 is untouched.
      const forkPairs = db.all(`
        SELECT
          a1.file AS file_a,
          a2.file AS file_b,
          MIN(a1.id) AS first_id_a,
          MIN(a2.id) AS first_id_b,
          COUNT(*) AS shared_count
        FROM activity_entries a1
        JOIN activity_entries a2
          ON a1.uuid = a2.uuid
          AND a1.file < a2.file
          AND a1.uuid IS NOT NULL
        GROUP BY a1.file, a2.file
        HAVING shared_count >= 1
      `) as Array<Record<string, unknown>>;

      for (const pair of forkPairs) {
        const fileA = pair.file_a as string;
        const fileB = pair.file_b as string;
        const firstIdA = pair.first_id_a as number;
        const firstIdB = pair.first_id_b as number;

        const parentFile = firstIdA <= firstIdB ? fileA : fileB;
        const childFile = parentFile === fileA ? fileB : fileA;

        const forkRow = db.get(`
          SELECT a1.uuid, a1.byte_offset
          FROM activity_entries a1
          JOIN activity_entries a2
            ON a1.uuid = a2.uuid
            AND a1.uuid IS NOT NULL
          WHERE a1.file = ? AND a2.file = ?
          ORDER BY a1.byte_offset DESC
          LIMIT 1
        `, [childFile, parentFile]) as Record<string, unknown> | undefined;

        const forkPointUuid = forkRow?.uuid as string | null ?? null;
        const forkPointOffset = forkRow?.byte_offset as number ?? 0;

        db.run(
          `INSERT OR IGNORE INTO session_lineage
           (session_file, parent_file, fork_point_uuid, fork_point_offset)
           VALUES (?, ?, ?, ?)`,
          [childFile, parentFile, forkPointUuid, forkPointOffset],
        );

        db.run(`
          DELETE FROM activity_entries
          WHERE file = ?
            AND uuid IS NOT NULL
            AND uuid IN (
              SELECT uuid FROM activity_entries
              WHERE file = ? AND uuid IS NOT NULL
            )
        `, [childFile, parentFile]);
      }
    },
  },
  {
    version: 5,
    description: 'Add status column to activity_entries for Rosie work-status tracking',
    up: (db: Database): void => {
      db.exec('ALTER TABLE activity_entries ADD COLUMN status TEXT');
    },
  },
  {
    version: 6,
    description: 'Add entities column to activity_entries for Rosie entity extraction',
    up: (db: Database): void => {
      db.exec('ALTER TABLE activity_entries ADD COLUMN entities TEXT');
    },
  },
  {
    version: 7,
    description: 'Create FTS5 full-text search index on activity_entries',
    up: (db: Database): void => {
      // External content FTS5 table — Porter stemmer + unicode61
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(
          quest, summary, title, entities, preview,
          content='activity_entries', content_rowid='id',
          tokenize='porter unicode61 remove_diacritics 2'
        );
      `);

      // Sync triggers — keep FTS5 in sync with activity_entries
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS activity_fts_ai AFTER INSERT ON activity_entries BEGIN
          INSERT INTO activity_fts(rowid, quest, summary, title, entities, preview)
          VALUES (new.id, new.quest, new.summary, new.title, new.entities, new.preview);
        END;

        CREATE TRIGGER IF NOT EXISTS activity_fts_ad AFTER DELETE ON activity_entries BEGIN
          INSERT INTO activity_fts(activity_fts, rowid, quest, summary, title, entities, preview)
          VALUES ('delete', old.id, old.quest, old.summary, old.title, old.entities, old.preview);
        END;

        CREATE TRIGGER IF NOT EXISTS activity_fts_au AFTER UPDATE ON activity_entries BEGIN
          INSERT INTO activity_fts(activity_fts, rowid, quest, summary, title, entities, preview)
          VALUES ('delete', old.id, old.quest, old.summary, old.title, old.entities, old.preview);
          INSERT INTO activity_fts(rowid, quest, summary, title, entities, preview)
          VALUES (new.id, new.quest, new.summary, new.title, new.entities, new.preview);
        END;
      `);

      // Backfill: populate FTS5 from all existing rows
      db.exec("INSERT INTO activity_fts(activity_fts) VALUES('rebuild')");

      // Configure BM25 column weights (column order: quest, summary, title, entities, preview)
      // quest(10): session goal, most concentrated signal
      // title(8): short label, highly informative
      // summary(5): turn summary, action detail
      // entities(3): file paths, concepts, tools
      // preview(1): raw prompt text, lowest signal density
      db.exec("INSERT INTO activity_fts(activity_fts, rank) VALUES('rank', 'bm25(10.0, 5.0, 8.0, 3.0, 1.0)')");
    },
  },
];

function runMigrations(db: Database, dbPath: string): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Find current version
  const row = db.get('SELECT MAX(version) as max_ver FROM _migrations');
  const currentVersion = (row && typeof (row as Record<string, unknown>).max_ver === 'number')
    ? (row as Record<string, unknown>).max_ver as number
    : 0;

  // Run pending migrations
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      db.exec('BEGIN');
      try {
        migration.up(db, dbPath);
        db.run(
          'INSERT INTO _migrations (version, description) VALUES (?, ?)',
          [migration.version, migration.description],
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }
}
