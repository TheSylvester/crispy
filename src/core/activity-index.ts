/**
 * Activity Index — Persistence Layer for User Activity Data
 *
 * Owns session metadata CRUD, session lineage, session title cache,
 * and pruning for ~/.crispy/. The underlying storage is a SQLite
 * database (crispy.db) managed by crispy-db.ts.
 *
 * Message-level recall storage lives in recall/message-store.ts.
 *
 * The activity index is an acceleration structure, not a source of truth.
 * Duplicates are prevented by a UNIQUE(file, ts, kind) constraint
 * with INSERT OR IGNORE.
 *
 * @module activity-index
 */

import * as fs from 'node:fs';
import { getDb, _resetDb } from './crispy-db.js';
import { log } from './log.js';
import { crispyRoot, dbPath, _setTestRoot } from './paths.js';
// Import registerLogPersister directly from log.ts to avoid the circular
// dependency through rosie/index.ts → rosie-bot-hook.ts → activity-index.ts.
// The barrel re-export triggers ESM cycle resolution issues in vitest.
import { registerLogPersister } from './log.js';
import type { LogEntry } from './log.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A single entry in the activity index.
 *
 * Represents a user prompt extracted from a session file.
 */
export interface ActivityIndexEntry {
  /** ISO 8601 timestamp of the prompt. */
  ts: string;
  /** Discriminator — 'prompt' for user prompts. */
  kind: 'prompt';
  /** Absolute path to the JSONL session file. */
  file: string;
  /** Preview text (~120 chars). */
  preview: string;
  /** Session UUID (optional — for self-filtering in recall). */
  session_id?: string;
  /** Model used in the session (optional). */
  model?: string;
  /** Working directory of the session (optional). */
  cwd?: string;
}


// ============================================================================
// Re-exports (9+ consumers import dbPath from here — keep working)
// ============================================================================

export { dbPath, crispyRoot };

/**
 * Override the crispy directory for testing.
 * Returns a cleanup function that restores the original paths.
 */
export function _setTestDir(dir: string): () => void {
  _resetDb(); // Close existing DB connection
  const restoreRoot = _setTestRoot(dir);
  sessionTitleCache = null;
  // Create dir and init DB in test directory
  fs.mkdirSync(dir, { recursive: true });
  getDb(dbPath());
  return () => {
    _resetDb(); // Close test DB
    restoreRoot();
    sessionTitleCache = null;
  };
}

// ============================================================================
// Directory Management
// ============================================================================

/**
 * Ensure ~/.crispy/ directory exists.
 * Creates with recursive: true so intermediate dirs are also created.
 * Triggers lazy DB initialization.
 */
export function ensureCrispyDir(): void {
  fs.mkdirSync(crispyRoot(), { recursive: true });
  getDb(dbPath());
}

// ============================================================================
// Event Log Persistence
// ============================================================================

/**
 * Persist a Rosie log entry to the event_log table.
 *
 * Registered as a late-binding callback into log.ts to break the
 * circular import chain (activity-index → rosie/index → log).
 * Silently swallows errors — the in-memory ring buffer is always the
 * primary path; this is a best-effort crash-survivable supplement.
 */
function persistLogEntry(entry: LogEntry): void {
  try {
    const db = getDb(dbPath());
    db.run(
      `INSERT INTO event_log (ts, source, level, summary, data)
       VALUES (?, ?, ?, ?, ?)`,
      [
        entry.ts,
        entry.source,
        entry.level,
        entry.summary,
        entry.data != null ? JSON.stringify(entry.data) : null,
      ],
    );
  } catch {
    // Non-fatal — never break the hot log path for a persistence failure
  }
}

// Wire up persistence so log() writes to SQLite automatically.
registerLogPersister(persistLogEntry);

/**
 * Lazy cache of session titles from the session_titles table.
 * Built on first access, invalidated by invalidateSessionTitleCache().
 */
let sessionTitleCache: Map<string, string> | null = null;

function buildSessionTitleCache(): Map<string, string> {
  try {
    const db = getDb(dbPath());
    const rows = db.all(`SELECT session_id, title FROM session_titles`) as
      Array<{ session_id: string; title: string }>;
    return new Map(rows.map(r => [r.session_id, r.title]));
  } catch {
    return new Map();
  }
}

/** Invalidate the session title cache, forcing a rebuild on next access. */
export function invalidateSessionTitleCache(): void {
  sessionTitleCache = null;
}

// ============================================================================
// Activity Index CRUD
// ============================================================================

/**
 * Append activity entries to the database.
 *
 * Uses INSERT OR IGNORE to handle duplicates via the UNIQUE constraint.
 * No-op if entries array is empty.
 *
 */
export function appendActivityEntries(entries: ActivityIndexEntry[]): void {
  if (entries.length === 0) return;

  ensureCrispyDir();
  const db = getDb(dbPath());

  db.exec('BEGIN');
  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO session_meta
       (ts, kind, file, preview, session_id, model, cwd)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const e of entries) {
        stmt.run([
          e.ts,
          e.kind,
          e.file,
          e.preview,
          e.session_id ?? null,
          e.model ?? null,
          e.cwd ?? null,
        ]);
      }
    } finally {
      stmt.finalize();
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

}

/**
 * Query activity entries from the database.
 *
 * Returns entries sorted by timestamp ascending. Supports optional
 * time range filtering with ISO 8601 strings and kind filtering.
 *
 * Returns empty array on any error (never throws).
 */
export function queryActivity(
  timeRange?: { from?: string; to?: string },
  kind?: ActivityIndexEntry['kind'],
  filePrefix?: string,
): ActivityIndexEntry[] {
  try {
    const db = getDb(dbPath());
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];

    if (kind) {
      conditions.push('kind = ?');
      params.push(kind);
    }
    if (timeRange?.from) {
      conditions.push('ts >= ?');
      params.push(timeRange.from);
    }
    if (timeRange?.to) {
      conditions.push('ts <= ?');
      params.push(timeRange.to);
    }
    if (filePrefix) {
      conditions.push('file LIKE ?');
      params.push(filePrefix + '%');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT ts, kind, file, preview, session_id, model, cwd
                 FROM session_meta ${where} ORDER BY ts ASC`;

    const rows = db.all(sql, params.length > 0 ? params : undefined);
    return rows.map(rowToEntry);
  } catch {
    return [];
  }
}


/**
 * Look up a session title from the session_titles table.
 * Uses a lazy in-memory cache.
 * Returns null if no title is set for this session.
 */
export function getSessionTitleFromDb(sessionId: string): string | null {
  if (!sessionTitleCache) {
    sessionTitleCache = buildSessionTitleCache();
  }
  return sessionTitleCache.get(sessionId) ?? null;
}

/**
 * Write a session title to the session_titles table.
 * Invalidates the in-memory cache after the write.
 */
export function setSessionTitle(sessionId: string, title: string): void {
  const db = getDb(dbPath());
  db.run(
    `INSERT OR REPLACE INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)`,
    [sessionId, title, new Date().toISOString()],
  );
  invalidateSessionTitleCache();
}

// ============================================================================
// Session Lineage
// ============================================================================

/**
 * Record a lineage relationship for a session file.
 *
 * @param sessionFile  - the JSONL file path of the fork (or fresh session)
 * @param parentFile   - the parent file path (null for fresh conversations)
 * @param forkPointUuid - the last shared message UUID before divergence
 * @param forkPointOffset - byte offset in the fork file where unique content begins
 */
export function recordLineage(
  sessionFile: string,
  parentFile: string | null,
  forkPointUuid: string | null,
  forkPointOffset: number,
): void {
  try {
    const db = getDb(dbPath());
    db.run(
      `INSERT OR REPLACE INTO session_lineage
       (session_file, parent_file, fork_point_uuid, fork_point_offset)
       VALUES (?, ?, ?, ?)`,
      [sessionFile, parentFile, forkPointUuid, forkPointOffset],
    );
  } catch {
    // Non-fatal — lineage is an optimization, not critical path
  }
}

/**
 * Get lineage information for a session file.
 * Returns null if no lineage record exists.
 */
export function getLineage(sessionFile: string): {
  parentFile: string | null;
  forkPointUuid: string | null;
  forkPointOffset: number;
} | null {
  try {
    const db = getDb(dbPath());
    const row = db.get(
      'SELECT parent_file, fork_point_uuid, fork_point_offset FROM session_lineage WHERE session_file = ?',
      [sessionFile],
    );
    if (!row) return null;
    const r = row as Record<string, unknown>;
    return {
      parentFile: r.parent_file as string | null,
      forkPointUuid: r.fork_point_uuid as string | null,
      forkPointOffset: r.fork_point_offset as number,
    };
  } catch {
    return null;
  }
}

/**
 * Bulk-load all session files that have lineage records.
 * Returns a Set for O(1) membership checks. Used by the scanner
 * to avoid per-file DB queries on every 30s poll cycle.
 */
export function getAllLineageFiles(): Set<string> {
  try {
    const db = getDb(dbPath());
    const rows = db.all('SELECT session_file FROM session_lineage');
    return new Set(rows.map((r) => (r as Record<string, unknown>).session_file as string));
  } catch {
    return new Set();
  }
}

/**
 * Get all child session files for a given parent file.
 */
export function getChildSessions(parentFile: string): string[] {
  try {
    const db = getDb(dbPath());
    const rows = db.all(
      'SELECT session_file FROM session_lineage WHERE parent_file = ?',
      [parentFile],
    );
    return rows.map((r) => (r as Record<string, unknown>).session_file as string);
  } catch {
    return [];
  }
}

/**
 * Bulk-load the full lineage graph for fork visualization.
 * Returns all parent→child edges from session_lineage.
 */
export function getLineageGraph(): Array<{ sessionFile: string; parentFile: string | null }> {
  try {
    const db = getDb(dbPath());
    const rows = db.all('SELECT session_file, parent_file FROM session_lineage');
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        sessionFile: row.session_file as string,
        parentFile: (row.parent_file as string) ?? null,
      };
    });
  } catch {
    return [];
  }
}

// ============================================================================
// Pruning
// ============================================================================

/**
 * Remove all DB rows referencing file paths that no longer exist on disk.
 *
 * Called at the end of each scan cycle with the set of live file paths from
 * listAllSessions(). Cleans session_meta (FTS5 auto-cascades via trigger)
 * and session_lineage in a single transaction.
 *
 * Never throws — returns 0 on error with log.
 */
export function pruneDeletedFiles(livePaths: Set<string>): number {
  try {
    const db = getDb(dbPath());

    // Collect all file paths referenced in the DB
    const dbPaths = new Set<string>();
    const activityRows = db.all('SELECT DISTINCT file FROM session_meta');
    for (const r of activityRows) {
      dbPaths.add((r as Record<string, unknown>).file as string);
    }
    const lineageRows = db.all('SELECT session_file FROM session_lineage');
    for (const r of lineageRows) {
      dbPaths.add((r as Record<string, unknown>).session_file as string);
    }

    // Find stale paths: in DB but not in live set
    const stalePaths: string[] = [];
    for (const p of dbPaths) {
      if (!livePaths.has(p)) {
        stalePaths.push(p);
      }
    }

    if (stalePaths.length === 0) return 0;

    db.exec('BEGIN');
    try {
      const delActivity = db.prepare('DELETE FROM session_meta WHERE file = ?');
      const delLineage = db.prepare('DELETE FROM session_lineage WHERE session_file = ?');
      const nullParent = db.prepare('UPDATE session_lineage SET parent_file = NULL WHERE parent_file = ?');

      try {
        for (const p of stalePaths) {
          delActivity.run([p]);
          delLineage.run([p]);
          nullParent.run([p]);
        }
      } finally {
        delActivity.finalize();
        delLineage.finalize();
        nullParent.finalize();
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // Invalidate caches — pruned files may have had session titles
    sessionTitleCache = null;

    if (stalePaths.length > 0) {
      log({ source: 'scanner', level: 'info', summary: `Index: pruned ${stalePaths.length} deleted sessions`, data: { count: stalePaths.length } });
    }
    return stalePaths.length;
  } catch (err) {
    log({ level: 'error', source: 'activity-index', summary: `pruneDeletedFiles error: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
    return 0;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function rowToEntry(row: Record<string, unknown>): ActivityIndexEntry {
  const r = row as Record<string, unknown>;
  const entry: ActivityIndexEntry = {
    ts: r.ts as string,
    kind: r.kind as 'prompt',
    file: r.file as string,
    preview: r.preview as string,
  };
  if (r.session_id != null) entry.session_id = r.session_id as string;
  if (r.model != null) entry.model = r.model as string;
  if (r.cwd != null) entry.cwd = r.cwd as string;
  return entry;
}
