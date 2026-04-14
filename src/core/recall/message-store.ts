/**
 * Message Store — Message-level persistence for the recall pipeline
 *
 * SQLite storage for transcript messages (FTS5-indexed) and their embedding
 * vectors (q8-quantized Nomic Embed Code). One row per user/assistant entry.
 * Sole persistence layer for the recall pipeline — the old chunk-based
 * pipeline has been removed.
 *
 * FTS5 search provides keyword matching; the message_vectors table stores
 * q8 embeddings for semantic similarity search. Both paths are orchestrated
 * by vector-search.ts.
 *
 * DB access goes through crispy-db.ts; path comes from activity-index.ts.
 * Write functions ensure ~/.crispy/ exists (once); read functions assume
 * the DB is already initialized.
 *
 * @module recall/message-store
 */

import { getDb } from '../crispy-db.js';
import { dbPath, ensureCrispyDir } from '../activity-index.js';
import { sanitizeFts5Query } from './query-sanitizer.js';
import { dotProductQ8 } from './quantize.js';

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
  message_role: string | null;
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
       (message_id, session_id, message_seq, message_text, project_id, created_at, message_role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
          m.message_role,
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
    const d = db();
    // Delete vectors explicitly — belt-and-suspenders with v15 CASCADE constraint
    d.run(
      `DELETE FROM message_vectors WHERE message_id IN
       (SELECT message_id FROM messages WHERE session_id = ?)`,
      [sessionId],
    );
    d.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
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
export type MessageSearchResult = Pick<MessageRecord, 'message_id' | 'session_id' | 'message_seq' | 'project_id' | 'created_at' | 'message_role'> & {
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
  excludeSessionId?: string,
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
    if (excludeSessionId) {
      extraClauses += 'AND m.session_id != ? ';
      params.push(excludeSessionId);
    }
    params.push(limit);

    const MAX_PREVIEW = 400;
    const rows = db().all(
      `SELECT m.message_id, m.session_id, m.message_seq,
              m.project_id, m.created_at, m.message_role, f.rank,
              snippet(messages_fts, 0, '>>>', '<<<', '...', 64) as match_snippet,
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
        message_role: (row.message_role as string) ?? null,
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
  excludeSessionId?: string,
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
    if (excludeSessionId) {
      extraClauses += 'AND m.session_id != ? ';
      params.push(excludeSessionId);
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
      `SELECT message_id, session_id, message_seq, message_text, project_id, created_at, message_role
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
      `SELECT message_id, session_id, message_seq, message_text, project_id, created_at, message_role
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
  message_role: string | null;
}

export function grepMessages(
  pattern: string,
  limit: number = 20,
  sessionId?: string,
  projectId?: string,
  excludeSessionId?: string,
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
    if (excludeSessionId) {
      where += ' AND session_id != ?';
      params.push(excludeSessionId);
    }
    // When scanning cross-session, cap the scan set to avoid reading the entire DB.
    // Ordered by created_at DESC so we search recent messages first.
    const scanLimit = sessionId ? 10000 : 2000;
    params.push(scanLimit);

    const rows = db().all(
      `SELECT message_id, session_id, message_seq, message_text, created_at, message_role
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
        message_role: (row.message_role as string) ?? null,
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
    role?: string;
    created_at?: number;
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
  reverse: boolean = false,
): SessionPage | null {
  try {
    const totalRow = db().get(
      'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?',
      [sessionId],
    );
    const total = totalRow ? (totalRow as Record<string, unknown>).cnt as number : 0;
    if (total === 0) return null;

    const rows = db().all(
      `SELECT message_id, message_seq, message_text, message_role, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY message_seq ${reverse ? 'DESC' : 'ASC'}
       LIMIT ? OFFSET ?`,
      [sessionId, limit, offset],
    );

    const messages = rows.map(r => {
      const row = r as Record<string, unknown>;
      return {
        message_seq: row.message_seq as number,
        message_id: row.message_id as string,
        text: row.message_text as string,
        role: (row.message_role as string) ?? undefined,
        created_at: (row.created_at as number) ?? undefined,
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
// Vector Write Functions
// ============================================================================

/** A single message vector record for batch insert. */
export interface MessageVectorRecord {
  messageId: string;
  embeddingQ8: Int8Array;
  norm: number;
  quantScale: number;
}

/**
 * Batch-insert message vectors into the message_vectors table.
 * Uses INSERT OR REPLACE so re-embedding overwrites previous vectors.
 */
export function insertMessageVectors(records: MessageVectorRecord[]): void {
  if (records.length === 0) return;

  ensureDir();
  const d = db();

  d.exec('BEGIN');
  try {
    const stmt = d.prepare(
      `INSERT OR REPLACE INTO message_vectors
       (message_id, embedding_q8, norm, quant_scale)
       VALUES (?, ?, ?, ?)`,
    );
    try {
      for (const r of records) {
        stmt.run([
          r.messageId,
          Buffer.from(r.embeddingQ8.buffer, r.embeddingQ8.byteOffset, r.embeddingQ8.byteLength),
          r.norm,
          r.quantScale,
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

// ============================================================================
// Vector Read Functions
// ============================================================================

/**
 * Check if a session already has vectors in message_vectors.
 * Used by the backfill CLI to skip already-processed sessions.
 */
export function hasSessionVectors(sessionId: string): boolean {
  try {
    const row = db().get(
      `SELECT 1 FROM message_vectors mv
       JOIN messages m ON m.message_id = mv.message_id
       WHERE m.session_id = ? LIMIT 1`,
      [sessionId],
    );
    return row != null;
  } catch {
    return false;
  }
}

/**
 * Semantic search over message_vectors using brute-force q8 dot product.
 *
 * Scans all vectors, computes approximate cosine similarity via q8 dot
 * product, and returns the top-N matches joined to messages for metadata.
 * Optionally scoped by project or session.
 */
export function searchMessagesSemantic(
  queryQ8: Int8Array,
  queryNorm: number,
  queryScale: number,
  opts?: { limit?: number; projectId?: string; sessionId?: string; excludeSessionId?: string },
): MessageSearchResult[] {
  try {
    const limit = opts?.limit ?? 20;

    // Push project/session filters to SQL to avoid loading unnecessary vectors
    const params: (string | number)[] = [];
    let filterClauses = '';
    if (opts?.projectId) {
      filterClauses += ' AND m.project_id = ?';
      params.push(opts.projectId);
    }
    if (opts?.sessionId) {
      filterClauses += ' AND m.session_id = ?';
      params.push(opts.sessionId);
    }
    if (opts?.excludeSessionId) {
      filterClauses += ' AND m.session_id != ?';
      params.push(opts.excludeSessionId);
    }

    const rows = db().all(
      `SELECT mv.message_id, mv.embedding_q8, mv.norm, mv.quant_scale,
              m.session_id, m.message_seq, m.project_id, m.created_at, m.message_role,
              SUBSTR(m.message_text, 1, 401) as message_preview_raw
       FROM message_vectors mv
       JOIN messages m ON m.message_id = mv.message_id
       WHERE 1=1${filterClauses}`,
      params,
    );

    if (rows.length === 0) return [];

    // Brute-force q8 dot product scan over filtered vectors
    const MAX_PREVIEW = 400;
    const scored: Array<{ row: Record<string, unknown>; score: number }> = [];

    for (const r of rows) {
      const row = r as Record<string, unknown>;

      const storedNorm = row.norm as number;
      if (storedNorm === 0 || queryNorm === 0) continue;

      const storedQ8Buf = row.embedding_q8 as Buffer;
      const storedQ8 = new Int8Array(
        storedQ8Buf.buffer,
        storedQ8Buf.byteOffset,
        storedQ8Buf.byteLength,
      );
      const storedScale = row.quant_scale as number;

      const dotRaw = dotProductQ8(queryQ8, storedQ8);
      const approxCosine = (dotRaw * queryScale * storedScale) / (queryNorm * storedNorm);

      scored.push({ row, score: approxCosine });
    }

    // Sort descending by score, take top-N
    scored.sort((a, b) => b.score - a.score);
    const topN = scored.slice(0, limit);

    return topN.map(({ row, score }) => {
      const raw = row.message_preview_raw as string;
      const truncated = raw.length > MAX_PREVIEW;
      return {
        message_id: row.message_id as string,
        session_id: row.session_id as string,
        message_seq: row.message_seq as number,
        project_id: (row.project_id as string) ?? null,
        created_at: row.created_at as number,
        message_role: (row.message_role as string) ?? null,
        rank: -score, // negative so lower = better (matches FTS5 convention)
        match_snippet: '',
        message_preview: truncated ? raw.slice(0, MAX_PREVIEW) : raw,
        truncated,
      };
    });
  } catch {
    return [];
  }
}

// ============================================================================
// Catch-up / Gap Detection
// ============================================================================

/**
 * Return all session IDs that already have messages in the FTS5 index.
 * Used for batch checking during catch-up (avoids N+1 hasSessionMessages calls).
 */
export function getIndexedSessionIds(): Set<string> {
  try {
    const rows = db().all(
      'SELECT DISTINCT session_id FROM messages',
    ) as Array<Record<string, unknown>>;
    return new Set(rows.map(r => r.session_id as string));
  } catch {
    return new Set();
  }
}

/** Messages shorter than this are skipped for embedding — trivial messages
 *  like "yes", "ok", "do it" add noise to semantic search. FTS5 still indexes them. */
const MIN_EMBED_CHARS = 50;

/**
 * Count total indexed messages and messages without embedding vectors.
 * Returns { totalMessages, gapCount } where gapCount is the number of
 * messages that need embedding.
 */
export function getEmbeddingGapStats(): { totalMessages: number; gapCount: number } {
  try {
    const row = db().get(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM message_vectors mv WHERE mv.message_id = m.message_id)
                       AND LENGTH(m.message_text) >= ${MIN_EMBED_CHARS} THEN 1 ELSE 0 END) as gap
       FROM messages m WHERE m.message_text != ''`,
    ) as Record<string, unknown> | undefined;
    return {
      totalMessages: row ? (row.total as number) : 0,
      gapCount: row ? (row.gap as number) : 0,
    };
  } catch {
    return { totalMessages: 0, gapCount: 0 };
  }
}

/**
 * Return session IDs that have messages without embedding vectors.
 * Ordered by most recent messages first.
 */
export function getSessionsWithEmbeddingGap(): string[] {
  try {
    const rows = db().all(
      `SELECT DISTINCT m.session_id FROM messages m
       WHERE m.message_text != ''
         AND LENGTH(m.message_text) >= ${MIN_EMBED_CHARS}
         AND NOT EXISTS (SELECT 1 FROM message_vectors mv WHERE mv.message_id = m.message_id)
       ORDER BY m.created_at DESC`,
    ) as Array<Record<string, unknown>>;
    return rows.map(r => r.session_id as string);
  } catch {
    return [];
  }
}

export interface UnembeddedMessage {
  message_id: string;
  session_id: string;
  message_text: string;
}

/**
 * Fetch unembedded messages across all sessions, most recent first.
 * Skips trivial messages (< MIN_EMBED_CHARS) so they never enter the pipeline.
 */
export function getUnembeddedMessages(limit: number): UnembeddedMessage[] {
  try {
    const rows = db().all(
      `SELECT m.message_id, m.session_id, m.message_text FROM messages m
       WHERE m.message_text != ''
         AND LENGTH(m.message_text) >= ${MIN_EMBED_CHARS}
         AND NOT EXISTS (SELECT 1 FROM message_vectors mv WHERE mv.message_id = m.message_id)
       ORDER BY m.created_at DESC
       LIMIT ?`,
      [limit],
    ) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      message_id: r.message_id as string,
      session_id: r.session_id as string,
      message_text: r.message_text as string,
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Infer message role from stored `message_role` with seq-parity fallback
 * for pre-v16 rows that haven't been backfilled yet.
 */
export function inferRole(role: string | null | undefined, seq: number): 'user' | 'assistant' {
  if (role === 'user' || role === 'assistant') return role;
  return seq % 2 === 0 ? 'user' : 'assistant';
}

function rowToMessage(row: Record<string, unknown>): MessageRecord {
  return {
    message_id: row.message_id as string,
    session_id: row.session_id as string,
    message_seq: row.message_seq as number,
    message_text: row.message_text as string,
    project_id: (row.project_id as string) ?? null,
    created_at: row.created_at as number,
    message_role: (row.message_role as string) ?? null,
  };
}
