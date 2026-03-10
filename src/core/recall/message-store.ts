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

export function searchMessagesFts(
  query: string,
  limit: number = 20,
  projectId?: string,
): MessageSearchResult[] {
  try {
    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    const params: (string | number)[] = [sanitized];
    let projectClause = '';
    if (projectId) {
      projectClause = 'AND m.project_id = ?';
      params.push(projectId);
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
         ${projectClause}
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
 */
export function getAdjacentMessages(
  sessionId: string,
  messageSeq: number,
): MessageRecord[] {
  try {
    const rows = db().all(
      `SELECT message_id, session_id, message_seq, message_text, project_id, created_at
       FROM messages
       WHERE session_id = ? AND message_seq BETWEEN ? AND ?
       ORDER BY message_seq ASC`,
      [sessionId, Math.max(0, messageSeq - 1), messageSeq + 1],
    );
    return rows.map(rowToMessage);
  } catch {
    return [];
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
