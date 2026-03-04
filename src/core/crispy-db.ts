/**
 * Crispy Database — SQLite Singleton via node-sqlite3-wasm
 *
 * Owns the Database instance lifecycle: lazy init, pragmas, migrations,
 * and clean shutdown. activity-index.ts is the sole consumer.
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
    up: (db: Database, dbPath: string) => {
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
