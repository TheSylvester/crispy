/**
 * Message Store — Message-level persistence for the recall pipeline
 *
 * SQLite storage for transcript messages (FTS5-indexed), one row per
 * user/assistant entry. Replaces the chunk-based pipeline for search
 * while the old chunks table stays for the disabled embedding path.
 *
 * DB access goes through crispy-db.ts; path comes from activity-index.ts.
 * Write functions ensure ~/.crispy/ exists (once); read functions assume
 * the DB is already initialized.
 *
 * @module recall/message-store
 */

import { getDb } from '../crispy-db.js';
import { dbPath, ensureCrispyDir } from '../activity-index.js';
import { sanitizeFts5Query } from '../../mcp/query-sanitizer.js';

// ============================================================================
// Types
// ============================================================================

/** A single message entry from a transcript, stored for FTS5 search. */
export interface MessageRecord {
  message_id: string;
  session_id: string;
  message_seq: number;
  message_text: string;
  project_id: string | null;
  created_at: number;         // unix timestamp ms
}

// ============================================================================
// DB Access
// ============================================================================

let dirEnsured = false;

function db() {
  return getDb(dbPath());
}

/** Ensure ~/.crispy/ exists before writes (cached after first call). */
function ensureDir() {
  if (!dirEnsured) {
    ensureCrispyDir();
    dirEnsured = true;
  }
}

// ============================================================================
// Write Functions
// ============================================================================

/**
 * Batch-insert messages into the messages table.
 * Uses a transaction for atomicity. FTS5 sync triggers fire automatically.
 */
export function insertMessages(messages: MessageRecord[]): void {
  if (messages.length === 0) return;

  ensureDir();
  const d = db();

  d.exec('BEGIN');
  try {
    const stmt = d.prepare(
      `INSERT OR IGNORE INTO messages
       (message_id, session_id, message_seq, message_text, project_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const m of messages) {
        stmt.run([
          m.message_id,
          m.session_id,
          m.message_seq,
          m.message_text,
          m.project_id,
          m.created_at,
        ]);
      }
    } finally {
      stmt.finalize();
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Delete all messages for a session.
 * FTS5 sync triggers fire automatically on delete.
 */
export function deleteSessionMessages(sessionId: string): void {
  try {
    db().run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
  } catch {
    // Non-fatal — recall is an optimization layer
  }
}

// ============================================================================
// Read Functions
// ============================================================================

/**
 * Full-text search across message content using FTS5 BM25 ranking.
 * Optionally scoped to a project by project_id.
 * Returns matching messages with relevance rank and match snippets.
 */
/** Search result: core message fields plus FTS5 rank and snippet. */
export type MessageSearchResult = Pick<MessageRecord, 'message_id' | 'session_id' | 'message_seq' | 'project_id' | 'created_at'> & {
  rank: number;
  match_snippet: string;
  message_preview: string;
  truncated: boolean;
};

/** Metadata envelope returned alongside search results. */
export interface MessageSearchMeta {
  total_matches: number;
  /** Per-session hit counts across the entire result set (not just the returned page). */
  session_hits: Record<string, number>;
}

export function searchMessagesFts(
  query: string,
  limit: number = 20,
  projectId?: string,
  sessionId?: string,
): MessageSearchResult[] {
  try {
    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    const params: (string | number)[] = [sanitized];
    let extraClauses = '';
    if (projectId) {
      extraClauses += 'AND m.project_id = ? ';
      params.push(projectId);
    }
    if (sessionId) {
      extraClauses += 'AND m.session_id = ? ';
      params.push(sessionId);
    }
    params.push(limit);

    const MAX_PREVIEW = 200;
    const rows = db().all(
      `SELECT m.message_id, m.session_id, m.message_seq,
              m.project_id, m.created_at, f.rank,
              snippet(messages_fts, 0, '>>>', '<<<', '...', 32) as match_snippet,
              SUBSTR(m.message_text, 1, ${MAX_PREVIEW + 1}) as message_preview_raw
       FROM messages_fts f
       CROSS JOIN messages m ON m.rowid = f.rowid
       WHERE messages_fts MATCH ?
         ${extraClauses}
       ORDER BY f.rank
       LIMIT ?`,
      params,
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      const raw = row.message_preview_raw as string;
      const truncated = raw.length > MAX_PREVIEW;
      return {
        message_id: row.message_id as string,
        session_id: row.session_id as string,
        message_seq: row.message_seq as number,
        project_id: (row.project_id as string) ?? null,
        created_at: row.created_at as number,
        rank: row.rank as number,
        match_snippet: row.match_snippet as string,
        message_preview: truncated ? raw.slice(0, MAX_PREVIEW) : raw,
        truncated,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Return total match count and per-session hit distribution for an FTS5 query.
 * Runs a lightweight GROUP BY query — no message content fetched.
 */
export function searchMessagesFtsMeta(
  query: string,
  projectId?: string,
  sessionId?: string,
): MessageSearchMeta {
  try {
    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return { total_matches: 0, session_hits: {} };

    const params: (string | number)[] = [sanitized];
    let extraClauses = '';
    if (projectId) {
      extraClauses += 'AND m.project_id = ? ';
      params.push(projectId);
    }
    if (sessionId) {
      extraClauses += 'AND m.session_id = ? ';
      params.push(sessionId);
    }

    const rows = db().all(
      `SELECT m.session_id, COUNT(*) as hit_count
       FROM messages_fts f
       CROSS JOIN messages m ON m.rowid = f.rowid
       WHERE messages_fts MATCH ?
         ${extraClauses}
       GROUP BY m.session_id`,
      params,
    );

    const session_hits: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const row = r as Record<string, unknown>;
      const sid = row.session_id as string;
      const count = row.hit_count as number;
      session_hits[sid] = count;
      total += count;
    }
    return { total_matches: total, session_hits };
  } catch {
    return { total_matches: 0, session_hits: {} };
  }
}

/**
 * Check if a session already has messages indexed.
 * Used to skip already-processed sessions during batch ingestion.
 */
export function hasSessionMessages(sessionId: string): boolean {
  try {
    const row = db().get(
      'SELECT 1 FROM messages WHERE session_id = ? LIMIT 1',
      [sessionId],
    );
    return row != null;
  } catch {
    return false;
  }
}

/**
 * Get a single message by session ID and message UUID.
 */
export function getMessageByUuid(sessionId: string, messageId: string): MessageRecord | null {
  try {
    const row = db().get(
      `SELECT message_id, session_id, message_seq, message_text, project_id, created_at
       FROM messages WHERE session_id = ? AND message_id = ?`,
      [sessionId, messageId],
    );
    if (!row) return null;
    return rowToMessage(row);
  } catch {
    return null;
  }
}

/**
 * Get adjacent messages by session ID and message_seq range.
 * Used by readMessageTurn to fetch a turn pair without loading the full transcript.
 * @param window — number of messages to include on each side of the target (default 1)
 */
export function getAdjacentMessages(
  sessionId: string,
  messageSeq: number,
  window: number = 1,
): MessageRecord[] {
  try {
    const rows = db().all(
      `SELECT message_id, session_id, message_seq, message_text, project_id, created_at
       FROM messages
       WHERE session_id = ? AND message_seq BETWEEN ? AND ?
       ORDER BY message_seq ASC`,
      [sessionId, Math.max(0, messageSeq - window), messageSeq + window],
    );
    return rows.map(rowToMessage);
  } catch {
    return [];
  }
}

/**
 * Regex search over message_text. Fetches messages (optionally scoped to a
 * session or project) and filters with a JS RegExp. Returns matching messages
 * with a short context snippet around the match.
 *
 * This complements FTS5: FTS5 finds keywords fast via index; grep finds
 * patterns, substrings, and near-matches by scanning the actual text.
 */
export interface GrepMatch {
  session_id: string;
  message_id: string;
  message_seq: number;
  /** The matched substring plus ~80 chars of surrounding context. */
  match_context: string;
  created_at: number;
}

export function grepMessages(
  pattern: string,
  limit: number = 20,
  sessionId?: string,
  projectId?: string,
): GrepMatch[] {
  try {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      // Invalid regex — fall back to literal substring
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    // Fetch candidate messages — session-scoped is fast, cross-session uses a limit
    const params: (string | number)[] = [];
    let where = 'WHERE 1=1';
    if (sessionId) {
      where += ' AND session_id = ?';
      params.push(sessionId);
    }
    if (projectId) {
      where += ' AND project_id = ?';
      params.push(projectId);
    }
    // When scanning cross-session, cap the scan set to avoid reading the entire DB.
    // Ordered by created_at DESC so we search recent messages first.
    const scanLimit = sessionId ? 10000 : 2000;
    params.push(scanLimit);

    const rows = db().all(
      `SELECT message_id, session_id, message_seq, message_text, created_at
       FROM messages ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      params,
    );

    const results: GrepMatch[] = [];
    for (const r of rows) {
      if (results.length >= limit) break;
      const row = r as Record<string, unknown>;
      const text = row.message_text as string;
      const match = re.exec(text);
      if (!match) continue;

      // Extract ~80 chars of context around the match
      const start = Math.max(0, match.index - 40);
      const end = Math.min(text.length, match.index + match[0].length + 40);
      const context = (start > 0 ? '...' : '') +
        text.slice(start, end) +
        (end < text.length ? '...' : '');

      results.push({
        session_id: row.session_id as string,
        message_id: row.message_id as string,
        message_seq: row.message_seq as number,
        match_context: context,
        created_at: row.created_at as number,
      });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Read sequential messages from a session with offset/limit pagination.
 * Returns messages in chronological order with a pagination footer.
 */
export interface SessionPage {
  messages: Array<{
    message_seq: number;
    message_id: string;
    text: string;
  }>;
  session_id: string;
  total_messages: number;
  showing_offset: number;
  showing_count: number;
  has_more: boolean;
}

export function readSessionMessages(
  sessionId: string,
  offset: number = 0,
  limit: number = 10,
): SessionPage | null {
  try {
    const totalRow = db().get(
      'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?',
      [sessionId],
    );
    const total = totalRow ? (totalRow as Record<string, unknown>).cnt as number : 0;
    if (total === 0) return null;

    const rows = db().all(
      `SELECT message_id, message_seq, message_text
       FROM messages
       WHERE session_id = ?
       ORDER BY message_seq ASC
       LIMIT ? OFFSET ?`,
      [sessionId, limit, offset],
    );

    const messages = rows.map(r => {
      const row = r as Record<string, unknown>;
      return {
        message_seq: row.message_seq as number,
        message_id: row.message_id as string,
        text: row.message_text as string,
      };
    });

    return {
      messages,
      session_id: sessionId,
      total_messages: total,
      showing_offset: offset,
      showing_count: messages.length,
      has_more: offset + messages.length < total,
    };
  } catch {
    return null;
  }
}

/**
 * Count total messages in a session. Used for "showing N of M" metadata.
 */
export function getSessionMessageCount(sessionId: string): number {
  try {
    const row = db().get(
      'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?',
      [sessionId],
    );
    return row ? (row as Record<string, unknown>).cnt as number : 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function rowToMessage(row: Record<string, unknown>): MessageRecord {
  return {
    message_id: row.message_id as string,
    session_id: row.session_id as string,
    message_seq: row.message_seq as number,
    message_text: row.message_text as string,
    project_id: (row.project_id as string) ?? null,
    created_at: row.created_at as number,
  };
}
