/**
 * Memory Query Functions — pure SQLite queries over the activity database.
 *
 * Extracted from the MCP tool handlers so they can be shared between:
 * - The internal stdio MCP server (raw tools for internal agents)
 * - The external in-process MCP server (recall tool with agent dispatch)
 * - Direct callers (tests, future graph search)
 *
 * All functions take an explicit dbPath — no process-level singletons.
 *
 * @module mcp/memory-queries
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../core/crispy-db.js';
import { sanitizeFts5Query } from './query-sanitizer.js';

// ============================================================================
// Types
// ============================================================================

export interface SearchResult {
  id: number;
  timestamp: string;
  kind: string;
  file: string;
  preview: string | null;
  quest: string | null;
  summary: string | null;
  title: string | null;
  status: string | null;
  entities: string | null;
  rank: number;
  match_snippet: string;
}

export interface ListResult {
  file: string;
  last_activity: string;
  quest: string | null;
  title: string | null;
  status: string | null;
  entry_count: number;
}

export interface ContextResult {
  id: number;
  timestamp: string;
  kind: string;
  file: string;
  preview: string | null;
  quest: string | null;
  summary: string | null;
  title: string | null;
  status: string | null;
  entities: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/** Default database path: ~/.crispy/crispy.db */
export function getDbPath(): string {
  return join(homedir(), '.crispy', 'crispy.db');
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * FTS5 full-text search over activity entries.
 *
 * Returns BM25-ranked results with match snippets. Supports natural
 * language or FTS5 syntax (AND, OR, NOT, "quoted phrases", prefix*).
 */
export function searchSessions(
  dbPath: string,
  query: string,
  limit: number = 20,
  kind?: string,
): SearchResult[] {
  const sanitized = sanitizeFts5Query(query);
  if (!sanitized) return [];

  const db = getDb(dbPath);
  const params: (string | number)[] = [sanitized];
  let kindClause = '';
  if (kind) {
    kindClause = 'AND ae.kind = ?';
    params.push(kind);
  }
  params.push(limit);

  return db.all(`
    SELECT ae.id, ae.timestamp, ae.kind, ae.file, ae.preview,
           ae.quest, ae.summary, ae.title, ae.status, ae.entities,
           bm25(activity_fts) as rank,
           snippet(activity_fts, 1, '>>>', '<<<', '...', 32) as match_snippet
    FROM activity_fts
    JOIN activity_entries ae ON ae.id = activity_fts.rowid
    WHERE activity_fts MATCH ?
      ${kindClause}
    ORDER BY rank
    LIMIT ?
  `, params) as unknown as SearchResult[];
}

/**
 * List distinct sessions with latest Rosie metadata.
 *
 * Sessions are grouped by transcript file and ordered by most recent
 * activity. Returns quest, title, status from the latest rosie-meta entry.
 */
export function listSessions(
  dbPath: string,
  limit: number = 50,
  since?: string,
): ListResult[] {
  const db = getDb(dbPath);
  const params: (string | number)[] = [];
  let whereClause = '';
  if (since) {
    whereClause = 'WHERE timestamp >= ?';
    params.push(since);
  }
  params.push(limit);

  return db.all(`
    SELECT file,
           MAX(timestamp) as last_activity,
           MAX(CASE WHEN kind = 'rosie-meta' THEN quest END) as quest,
           MAX(CASE WHEN kind = 'rosie-meta' THEN title END) as title,
           MAX(CASE WHEN kind = 'rosie-meta' THEN status END) as status,
           COUNT(*) as entry_count
    FROM activity_entries
    ${whereClause}
    GROUP BY file
    ORDER BY last_activity DESC
    LIMIT ?
  `, params) as unknown as ListResult[];
}

/**
 * Get full activity history for a specific session file.
 *
 * Returns all prompts and Rosie summaries in chronological order.
 * Optionally filter by entry kind.
 */
export function sessionContext(
  dbPath: string,
  file: string,
  kind?: string,
): ContextResult[] {
  const db = getDb(dbPath);
  const params: string[] = [file];
  let kindClause = '';
  if (kind) {
    kindClause = 'AND kind = ?';
    params.push(kind);
  }

  return db.all(`
    SELECT id, timestamp, kind, file, preview, quest, summary, title, status, entities
    FROM activity_entries
    WHERE file = ?
      ${kindClause}
    ORDER BY timestamp ASC
  `, params) as unknown as ContextResult[];
}
