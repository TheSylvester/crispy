/**
 * Activity Index — Persistence Layer for User Activity Data
 *
 * Owns session metadata CRUD, session lineage, rosie metadata cache,
 * and pruning for ~/.crispy/. The underlying storage is a SQLite
 * database (crispy.db) managed by crispy-db.ts.
 *
 * Message-level recall storage lives in recall/message-store.ts.
 *
 * The activity index is an acceleration structure, not a source of truth.
 * Duplicates are prevented by a UNIQUE(timestamp, file, uuid) constraint
 * with INSERT OR IGNORE. NULL uuids are treated as unique per SQLite
 * semantics — this matches the old JSONL behavior where entries without
 * UUIDs could be duplicated.
 *
 * @module activity-index
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getDb, _resetDb } from './crispy-db.js';
import { log } from './log.js';
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
  timestamp: string;
  /** Discriminator — 'prompt' for user prompts, 'rosie-meta' for Rosie Bot metadata. */
  kind: 'prompt' | 'rosie-meta';
  /** Absolute path to the JSONL session file. */
  file: string;
  /** Preview text (~120 chars). */
  preview: string;
  /** Byte offset of this entry in the JSONL file. */
  offset: number;
  /** Entry UUID for jump-to navigation (optional). */
  uuid?: string;
  /** Rosie Bot: main conversation goal (rosie-meta entries only). */
  quest?: string;
  /** Rosie Bot: most recent turn summary (rosie-meta entries only). */
  summary?: string;
  /** Rosie Bot: short conversation label (rosie-meta entries only). */
  title?: string;
  /** Rosie Bot: current work status — done, in progress, blocked (rosie-meta entries only). */
  status?: string;
  /** Rosie Bot: JSON array of extracted entities — file paths, concepts, tools, error types (rosie-meta entries only). */
  entities?: string;
}


// ============================================================================
// Paths
// ============================================================================

let crispyDir = join(homedir(), '.crispy');

/** Get the path to the database file. */
export function dbPath(): string {
  return join(crispyDir, 'crispy.db');
}

/**
 * Override the crispy directory for testing.
 * Returns a cleanup function that restores the original paths.
 */
export function _setTestDir(dir: string): () => void {
  const prevDir = crispyDir;
  _resetDb(); // Close existing DB connection
  crispyDir = dir;
  rosieMetaCache = null;
  // Create dir and init DB in test directory
  fs.mkdirSync(dir, { recursive: true });
  getDb(dbPath());
  return () => {
    _resetDb(); // Close test DB
    crispyDir = prevDir;
    rosieMetaCache = null;
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
  fs.mkdirSync(crispyDir, { recursive: true });
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

// ============================================================================
// Rosie Metadata Cache
// ============================================================================

/**
 * In-memory cache of the latest rosie-meta entry per session file path.
 *
 * Built lazily from a single queryActivity() call, then served from memory
 * on subsequent getLatestRosieMeta() calls. Invalidated when new rosie-meta
 * entries are appended via appendActivityEntries().
 */
let rosieMetaCache: Map<string, ActivityIndexEntry> | null = null;

/** Build the cache from a single full read of the activity index. */
function buildRosieMetaCache(): Map<string, ActivityIndexEntry> {
  const entries = queryActivity(undefined, 'rosie-meta');
  const map = new Map<string, ActivityIndexEntry>();
  // Iterate forward — last entry per file wins (latest by timestamp)
  for (const e of entries) {
    if (e.quest && e.summary) {
      map.set(e.file, e);
    }
  }
  return map;
}

/** Invalidate the rosie metadata cache, forcing a rebuild on next access. */
export function invalidateRosieMetaCache(): void {
  rosieMetaCache = null;
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
 * Invalidates the rosie metadata cache when rosie-meta entries are written.
 */
export function appendActivityEntries(entries: ActivityIndexEntry[]): void {
  if (entries.length === 0) return;

  ensureCrispyDir();
  const db = getDb(dbPath());

  db.exec('BEGIN');
  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO session_meta
       (timestamp, kind, file, preview, byte_offset, uuid, quest, summary, title, status, entities)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const e of entries) {
        stmt.run([
          e.timestamp,
          e.kind,
          e.file,
          e.preview,
          e.offset,
          e.uuid ?? null,
          e.quest ?? null,
          e.summary ?? null,
          e.title ?? null,
          e.status ?? null,
          e.entities ?? null,
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

  // Invalidate rosie cache when rosie-meta entries are appended
  if (entries.some((e) => e.kind === 'rosie-meta')) {
    rosieMetaCache = null;
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
      conditions.push('timestamp >= ?');
      params.push(timeRange.from);
    }
    if (timeRange?.to) {
      conditions.push('timestamp <= ?');
      params.push(timeRange.to);
    }
    if (filePrefix) {
      conditions.push('file LIKE ?');
      params.push(filePrefix + '%');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT timestamp, kind, file, preview, byte_offset, uuid, quest, summary, title, status, entities
                 FROM session_meta ${where} ORDER BY timestamp ASC`;

    const rows = db.all(sql, params.length > 0 ? params : undefined);
    return rows.map(rowToEntry);
  } catch {
    return [];
  }
}

/**
 * Get the most recent rosie-meta entry from the activity index.
 *
 * When `filePath` is provided, returns the latest entry for that specific
 * session file. Otherwise returns the global latest.
 *
 * Uses an in-memory cache to avoid re-querying the DB on every call.
 */
export function getLatestRosieMeta(filePath?: string): ActivityIndexEntry | undefined {
  if (!rosieMetaCache) {
    rosieMetaCache = buildRosieMetaCache();
  }
  if (filePath) {
    return rosieMetaCache.get(filePath);
  }
  // No filePath = find the global latest (rare path)
  let latest: ActivityIndexEntry | undefined;
  for (const entry of rosieMetaCache.values()) {
    if (!latest || entry.timestamp > latest.timestamp) {
      latest = entry;
    }
  }
  return latest;
}

/**
 * Get all rosie-meta entries for a session file, ordered chronologically.
 * Used by rosie-bot-hook to build the "middle" section of bookend transcripts.
 */
export function getAllRosieMetas(filePath: string): Pick<ActivityIndexEntry, 'timestamp' | 'quest' | 'title' | 'summary' | 'status'>[] {
  ensureCrispyDir();
  const db = getDb(dbPath());
  const rows = db.all(`
    SELECT timestamp, quest, title, summary, status
    FROM session_meta
    WHERE kind = 'rosie-meta' AND file = ?
    ORDER BY timestamp ASC
  `, [filePath]) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    timestamp: (r.timestamp as string) ?? '',
    quest: (r.quest as string) ?? '',
    title: (r.title as string) ?? '',
    summary: (r.summary as string) ?? '',
    status: (r.status as string) ?? '',
  }));
}

// ============================================================================
// Session Lineage
// ============================================================================

/**
 * Check if any of the given UUIDs exist in session_meta under a different file.
 * Returns the parent file path and the matching UUID, or null if no match.
 * Used by the scanner to detect fork lineage before first scan of a new file.
 */
export function findParentByUuids(
  uuids: string[],
  excludeFile: string,
): { parentFile: string; matchedUuid: string } | null {
  try {
    const db = getDb(dbPath());
    for (const uuid of uuids) {
      const row = db.get(
        'SELECT file FROM session_meta WHERE uuid = ? AND file != ? LIMIT 1',
        [uuid, excludeFile],
      );
      if (row) {
        return {
          parentFile: (row as Record<string, unknown>).file as string,
          matchedUuid: uuid,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get all non-null UUIDs indexed for a given file.
 * Used to build the parent UUID set for fork divergence detection.
 */
export function getFileUuids(file: string): Set<string> {
  try {
    const db = getDb(dbPath());
    const rows = db.all(
      'SELECT uuid FROM session_meta WHERE file = ? AND uuid IS NOT NULL',
      [file],
    );
    return new Set(rows.map((r) => (r as Record<string, unknown>).uuid as string));
  } catch {
    return new Set();
  }
}

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

/**
 * Delete duplicate activity entries from a child file that share UUIDs
 * with a parent file. Used during retroactive lineage detection for
 * files that were scanned before the lineage feature existed.
 */
export function deleteDuplicateEntries(
  childFile: string,
  parentFile: string,
): void {
  try {
    const db = getDb(dbPath());
    db.run(`
      DELETE FROM session_meta
      WHERE file = ?
        AND uuid IS NOT NULL
        AND uuid IN (
          SELECT uuid FROM session_meta
          WHERE file = ? AND uuid IS NOT NULL
        )
    `, [childFile, parentFile]);
  } catch {
    // Non-fatal
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

    // Invalidate rosie cache — pruned files may have had rosie-meta entries
    rosieMetaCache = null;

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
    timestamp: r.timestamp as string,
    kind: r.kind as 'prompt' | 'rosie-meta',
    file: r.file as string,
    preview: r.preview as string,
    offset: r.byte_offset as number,
  };
  if (r.uuid != null) entry.uuid = r.uuid as string;
  if (r.quest != null) entry.quest = r.quest as string;
  if (r.summary != null) entry.summary = r.summary as string;
  if (r.title != null) entry.title = r.title as string;
  if (r.status != null) entry.status = r.status as string;
  if (r.entities != null) entry.entities = r.entities as string;
  return entry;
}
