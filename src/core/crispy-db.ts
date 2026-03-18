/**
 * Crispy Database — SQLite Singleton via node-sqlite3-wasm
 *
 * Owns the Database instance lifecycle: lazy init, pragmas, schema,
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

import { log } from './log.js';
import type { Database } from 'node-sqlite3-wasm';
import { Database as DatabaseConstructor } from 'node-sqlite3-wasm';

// ============================================================================
// Singleton
// ============================================================================

let db: Database | null = null;
let currentDbPath: string | null = null;

/**
 * Get or create the SQLite database singleton.
 *
 * On first call, opens the database file (creating it if needed),
 * sets concurrency pragmas, and runs schema setup.
 * Subsequent calls return the cached instance if the path matches.
 */
export function getDb(dbPath: string): Database {
  if (db && currentDbPath === dbPath) return db;

  // Close any existing connection before opening a new one
  if (db) {
    closeDb();
  }

  db = new DatabaseConstructor(dbPath);
  currentDbPath = dbPath;

  // Concurrency: wait up to 5s if another process holds the lock
  db.exec('PRAGMA busy_timeout = 5000');

  // Explicit rollback journal (WAL unavailable in WASM — silently falls
  // back to delete anyway, but be clear about intent)
  db.exec('PRAGMA journal_mode = DELETE');

  // Enable foreign key enforcement (OFF by default in SQLite)
  db.exec('PRAGMA foreign_keys = ON');

  ensureSchema(db);
  log({ source: 'db', level: 'info', summary: `DB: initialized at ${dbPath}` });

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
// Schema — single-pass creation of all tables, indexes, triggers, seed data
// ============================================================================

function ensureSchema(db: Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Check if schema already exists
  const row = db.get('SELECT MAX(version) as max_ver FROM _migrations');
  const currentVersion = (row && typeof (row as Record<string, unknown>).max_ver === 'number')
    ? (row as Record<string, unknown>).max_ver as number
    : 0;

  // v2 = current schema. Return early — nothing to do.
  if (currentVersion === 2) return;

  // Old DBs (v1 or the legacy 24-migration system) — wipe and recreate.
  if (currentVersion >= 1) {
    log({ source: 'db', level: 'info', summary: `DB: detected old schema v${currentVersion} — dropping and recreating` });
    // Drop all known tables (order matters for FKs)
    db.exec(`
      DROP TRIGGER IF EXISTS session_meta_fts_ai;
      DROP TRIGGER IF EXISTS session_meta_fts_ad;
      DROP TRIGGER IF EXISTS session_meta_fts_au;
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      DROP TRIGGER IF EXISTS commit_fts_ai;
      DROP TRIGGER IF EXISTS commit_fts_ad;
      DROP TRIGGER IF EXISTS commit_fts_au;
      DROP TRIGGER IF EXISTS activity_fts_ai;
      DROP TRIGGER IF EXISTS activity_fts_ad;
      DROP TRIGGER IF EXISTS activity_fts_au;
      DROP TABLE IF EXISTS session_meta_fts;
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS commit_fts;
      DROP TABLE IF EXISTS activity_fts;
      DROP TABLE IF EXISTS message_vectors;
      DROP TABLE IF EXISTS commit_file_changes;
      DROP TABLE IF EXISTS project_activity;
      DROP TABLE IF EXISTS project_files;
      DROP TABLE IF EXISTS project_sessions;
      DROP TABLE IF EXISTS tracker_outcomes;
      DROP TABLE IF EXISTS rosie_usage;
      DROP TABLE IF EXISTS event_log;
      DROP TABLE IF EXISTS provenance_repo_state;
      DROP TABLE IF EXISTS provenance_scan_state;
      DROP TABLE IF EXISTS commit_index;
      DROP TABLE IF EXISTS file_mutations;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS stages;
      DROP TABLE IF EXISTS session_titles;
      DROP TABLE IF EXISTS session_lineage;
      DROP TABLE IF EXISTS session_meta;
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS scan_state;
      DROP TABLE IF EXISTS activity_entries;
      DROP TABLE IF EXISTS chunk_vectors;
      DROP TABLE IF EXISTS chunks_fts;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS _migrations;
    `);
    // Recreate the _migrations table for the new schema
    db.exec(`
      CREATE TABLE _migrations (
        version     INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  db.exec('BEGIN');
  try {
    // ====================================================================
    // session_lineage — fork tracking
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_lineage (
        session_file      TEXT PRIMARY KEY,
        parent_file       TEXT,
        fork_point_uuid   TEXT,
        fork_point_offset INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_lineage_parent ON session_lineage(parent_file);
    `);

    // ====================================================================
    // session_titles — display name cache
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_titles (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // ====================================================================
    // projects — project board
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id               TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        stage            TEXT NOT NULL,
        status           TEXT,
        icon             TEXT,
        sort_order       INTEGER,
        blocked_by       TEXT,
        summary          TEXT,
        category         TEXT,
        branch           TEXT,
        entities         TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        last_activity_at TEXT,
        closed_at        TEXT,
        parent_id        TEXT,
        type             TEXT NOT NULL DEFAULT 'project'
      );

      CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id);
    `);

    // ====================================================================
    // project_sessions — session↔project links
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_sessions (
        project_id   TEXT NOT NULL REFERENCES projects(id),
        session_file TEXT NOT NULL,
        detected_in  TEXT,
        linked_at    TEXT NOT NULL,
        PRIMARY KEY (project_id, session_file)
      );

      CREATE INDEX IF NOT EXISTS idx_project_sessions_file ON project_sessions(session_file);
    `);

    // ====================================================================
    // project_files — file↔project links
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_files (
        project_id   TEXT NOT NULL REFERENCES projects(id),
        file_path    TEXT NOT NULL,
        session_file TEXT,
        message_id   TEXT,
        note         TEXT,
        added_at     TEXT NOT NULL,
        UNIQUE (project_id, file_path)
      );
    `);

    // ====================================================================
    // project_activity — activity log
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_activity (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id   TEXT NOT NULL REFERENCES projects(id),
        session_file TEXT,
        ts           INTEGER NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN (
          'created','stage_change','status_update','session_linked','file_linked','entity_added'
        )),
        old_stage    TEXT,
        new_stage    TEXT,
        old_status   TEXT,
        new_status   TEXT,
        narrative    TEXT,
        actor        TEXT NOT NULL DEFAULT 'rosie'
      );

      CREATE INDEX IF NOT EXISTS idx_project_activity_project ON project_activity(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_activity_ts ON project_activity(ts);
    `);

    // ====================================================================
    // stages — stage definitions with descriptions for prompt injection
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS stages (
        name        TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        sort_order  INTEGER NOT NULL,
        icon        TEXT,
        color       TEXT
      );

      INSERT INTO stages (name, description, sort_order, color, icon) VALUES
        ('idea',      'Captured but not yet evaluated',         10, '#9ca3af', '💡'),
        ('planning',  'Being scoped or specced out',            20, '#a78bfa', '📋'),
        ('ready',     'Specced and ready to start',             30, '#60a5fa', '🎯'),
        ('active',    'Currently being worked on',              40, '#34d399', '🔨'),
        ('paused',    'Temporarily on hold',                    50, '#fbbf24', '⏸️'),
        ('committed', 'Code complete, awaiting merge/deploy',   60, '#f472b6', '✅'),
        ('done',      'Shipped and verified',                   70, '#6ee7b7', '🎉'),
        ('archived',  'No longer relevant',                     80, '#6b7280', '📦');
    `);

    // ====================================================================
    // messages — recall message index
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        message_id    TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        message_seq   INTEGER NOT NULL,
        message_text  TEXT NOT NULL,
        project_id    TEXT,
        created_at    INTEGER NOT NULL,
        message_role  TEXT,
        UNIQUE(session_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
    `);

    // ====================================================================
    // messages_fts — full-text search over messages
    // ====================================================================
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_text,
        content=messages,
        content_rowid=rowid,
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, message_text) VALUES (new.rowid, new.message_text);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, message_text)
        VALUES ('delete', old.rowid, old.message_text);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, message_text)
        VALUES ('delete', old.rowid, old.message_text);
        INSERT INTO messages_fts(rowid, message_text) VALUES (new.rowid, new.message_text);
      END;
    `);

    // ====================================================================
    // message_vectors — embedding vectors for semantic search
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_vectors (
        message_id    TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,
        embedding_q8  BLOB NOT NULL,
        norm          REAL NOT NULL,
        quant_scale   REAL NOT NULL
      );
    `);

    // ====================================================================
    // file_mutations — provenance tracking
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_mutations (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_file   TEXT NOT NULL,
        session_id     TEXT,
        tool           TEXT NOT NULL,
        bash_category  TEXT,
        file_path      TEXT,
        timestamp      TEXT,
        message_uuid   TEXT,
        tool_use_id    TEXT,
        byte_offset    INTEGER NOT NULL,
        command         TEXT,
        old_hash        TEXT,
        new_hash        TEXT,
        commit_sha      TEXT,
        UNIQUE (session_file, tool_use_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mut_file ON file_mutations(file_path);
      CREATE INDEX IF NOT EXISTS idx_mut_session ON file_mutations(session_file);
      CREATE INDEX IF NOT EXISTS idx_mut_commit ON file_mutations(commit_sha);
      CREATE INDEX IF NOT EXISTS idx_mut_ts ON file_mutations(timestamp);
    `);

    // ====================================================================
    // commit_index — git commit provenance
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS commit_index (
        sha              TEXT PRIMARY KEY,
        message          TEXT NOT NULL,
        author           TEXT,
        author_date      TEXT NOT NULL,
        repo_path        TEXT NOT NULL,
        session_file     TEXT,
        session_id       TEXT,
        message_uuid     TEXT,
        match_confidence REAL NOT NULL DEFAULT 0.0,
        matched_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_ci_session ON commit_index(session_file);
      CREATE INDEX IF NOT EXISTS idx_ci_date ON commit_index(author_date);
      CREATE INDEX IF NOT EXISTS idx_ci_repo ON commit_index(repo_path);
    `);

    // ====================================================================
    // commit_file_changes — per-file stats for commits
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS commit_file_changes (
        commit_sha  TEXT NOT NULL REFERENCES commit_index(sha),
        file_path   TEXT NOT NULL,
        additions   INTEGER NOT NULL DEFAULT 0,
        deletions   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (commit_sha, file_path)
      );
    `);

    // ====================================================================
    // commit_fts — full-text search over commit messages
    // ====================================================================
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS commit_fts USING fts5(
        message,
        content='commit_index', content_rowid='rowid',
        tokenize='porter unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS commit_fts_ai AFTER INSERT ON commit_index BEGIN
        INSERT INTO commit_fts(rowid, message) VALUES (new.rowid, new.message);
      END;

      CREATE TRIGGER IF NOT EXISTS commit_fts_ad AFTER DELETE ON commit_index BEGIN
        INSERT INTO commit_fts(commit_fts, rowid, message)
        VALUES ('delete', old.rowid, old.message);
      END;

      CREATE TRIGGER IF NOT EXISTS commit_fts_au AFTER UPDATE ON commit_index BEGIN
        INSERT INTO commit_fts(commit_fts, rowid, message)
        VALUES ('delete', old.rowid, old.message);
        INSERT INTO commit_fts(rowid, message) VALUES (new.rowid, new.message);
      END;
    `);

    // ====================================================================
    // provenance_scan_state — scan resume state
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS provenance_scan_state (
        file_path   TEXT PRIMARY KEY,
        mtime       INTEGER NOT NULL,
        size        INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0
      );
    `);

    // ====================================================================
    // provenance_repo_state — HEAD tracking
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS provenance_repo_state (
        repo_path   TEXT PRIMARY KEY,
        head_sha    TEXT NOT NULL,
        scanned_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ====================================================================
    // event_log — persistent audit log
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_log (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        source  TEXT NOT NULL,
        level   TEXT NOT NULL DEFAULT 'info',
        summary TEXT NOT NULL,
        data    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_event_log_source ON event_log(source);
      CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log(ts);
    `);

    // ====================================================================
    // rosie_usage — per-invocation token tracking
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS rosie_usage (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_file TEXT NOT NULL,
        subsystem    TEXT NOT NULL DEFAULT 'tracker',
        outcome      TEXT,
        reason       TEXT,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        cached_tokens INTEGER,
        model        TEXT,
        cost_usd     REAL,
        created_at   TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_rosie_usage_session ON rosie_usage(session_file);
      CREATE INDEX IF NOT EXISTS idx_rosie_usage_subsystem ON rosie_usage(subsystem);
    `);

    // ====================================================================
    // tracker_outcomes — backfill dedup marker
    // ====================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS tracker_outcomes (
        session_file TEXT PRIMARY KEY,
        outcome      TEXT NOT NULL CHECK (outcome IN ('tracked', 'trivial', 'failed')),
        reason       TEXT,
        attempts     INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Record schema version
    db.run(
      'INSERT INTO _migrations (version, description) VALUES (?, ?)',
      [2, 'remove session_meta, consolidate on messages'],
    );

    db.exec('COMMIT');
    log({ source: 'db', level: 'info', summary: 'DB: schema v2 created — session_meta removed, consolidated on messages' });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
