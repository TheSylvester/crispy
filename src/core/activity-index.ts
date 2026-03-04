/**
 * Activity Index — Persistence Layer for User Activity Data
 *
 * Owns ALL reads/writes to ~/.crispy/. No other module should touch these
 * files directly. The underlying storage is a SQLite database (crispy.db)
 * managed by crispy-db.ts. Provides:
 * - CRUD for activity entries (user prompts and rosie-meta)
 * - Scan state persistence (scan progress tracking)
 * - Rosie Bot metadata queries (getLatestRosieMeta)
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
}

/**
 * Per-file scan progress.
 *
 * Tracks mtime/size/offset for incremental scanning. If the file shrinks
 * (truncated), the scanner resets offset to 0 and re-scans.
 */
export interface ScanFileState {
  /** File mtime in milliseconds. */
  mtime: number;
  /** File size in bytes. */
  size: number;
  /** Byte offset where scanning left off. */
  offset: number;
}

/**
 * Root scan state persisted to the scan_state table.
 *
 * Version field for API compatibility. Files map is keyed by
 * absolute file path.
 */
export interface ScanState {
  version: 1;
  files: Record<string, ScanFileState>;
}

// ============================================================================
// Paths
// ============================================================================

let crispyDir = join(homedir(), '.crispy');

/** Get the path to the database file. */
function dbPath(): string {
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
// Scan State CRUD
// ============================================================================

/**
 * Load scan state from the database.
 *
 * Returns default { version: 1, files: {} } if:
 * - Database doesn't exist yet
 * - Table is empty
 * - Any error occurs
 *
 * Never throws — always returns a valid ScanState.
 */
export function loadScanState(): ScanState {
  const defaultState: ScanState = { version: 1, files: {} };

  try {
    const db = getDb(dbPath());
    const rows = db.all('SELECT file_path, mtime, size, byte_offset FROM scan_state');
    const files: Record<string, ScanFileState> = {};
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      files[r.file_path as string] = {
        mtime: r.mtime as number,
        size: r.size as number,
        offset: r.byte_offset as number,
      };
    }
    return { version: 1, files };
  } catch {
    return defaultState;
  }
}

/**
 * Save scan state to the database.
 *
 * Replaces all existing scan state rows in a single transaction.
 */
export function saveScanState(state: ScanState): void {
  ensureCrispyDir();
  const db = getDb(dbPath());

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM scan_state');
    const stmt = db.prepare(
      'INSERT INTO scan_state (file_path, mtime, size, byte_offset) VALUES (?, ?, ?, ?)',
    );
    try {
      for (const [path, s] of Object.entries(state.files)) {
        stmt.run([path, s.mtime, s.size, s.offset]);
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
      `INSERT OR IGNORE INTO activity_entries
       (timestamp, kind, file, preview, byte_offset, uuid, quest, summary, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const sql = `SELECT timestamp, kind, file, preview, byte_offset, uuid, quest, summary, title
                 FROM activity_entries ${where} ORDER BY timestamp ASC`;

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

// ============================================================================
// Session Lineage
// ============================================================================

/**
 * Check if any of the given UUIDs exist in activity_entries under a different file.
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
        'SELECT file FROM activity_entries WHERE uuid = ? AND file != ? LIMIT 1',
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
      'SELECT uuid FROM activity_entries WHERE file = ? AND uuid IS NOT NULL',
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
  return entry;
}
