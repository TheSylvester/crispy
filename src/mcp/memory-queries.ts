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

import { getDb } from '../core/crispy-db.js';
import { dbPath as crispyDbPath } from '../core/activity-index.js';
import { sanitizeFts5Query } from './query-sanitizer.js';
import { readClaudeTurnContent, type TurnContent } from '../core/adapters/claude/jsonl-reader.js';
import { readCodexTurnContent } from '../core/adapters/codex/codex-jsonl-reader.js';
import { searchMessagesFtsMeta, getMessageByUuid, getAdjacentMessages, getSessionMessageCount, grepMessages, readSessionMessages, inferRole } from '../core/recall/message-store.js';
import type { MessageRecord, MessageSearchResult, MessageSearchMeta, GrepMatch, SessionPage } from '../core/recall/message-store.js';
import { dualPathSearch } from '../core/recall/vector-search.js';

export type { TurnContent, MessageRecord, MessageSearchResult, MessageSearchMeta, GrepMatch, SessionPage };
export { grepMessages, readSessionMessages };

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
  return crispyDbPath();
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
  since?: string,
  before?: string,
): SearchResult[] {
  const sanitized = sanitizeFts5Query(query);
  if (!sanitized) return [];

  const db = getDb(dbPath);
  const params: (string | number)[] = [sanitized];
  let extraClauses = '';
  if (kind) {
    extraClauses += 'AND ae.kind = ? ';
    params.push(kind);
  }
  if (since) {
    extraClauses += 'AND ae.timestamp >= ? ';
    params.push(since);
  }
  if (before) {
    extraClauses += 'AND ae.timestamp <= ? ';
    params.push(before);
  }
  params.push(limit);

  return db.all(`
    SELECT ae.id, ae.timestamp, ae.kind, ae.file, ae.preview,
           ae.quest, ae.summary, ae.title, ae.status, ae.entities,
           bm25(activity_fts, 10.0, 8.0, 4.0, 3.0, 1.0) as rank,
           snippet(activity_fts, 1, '>>>', '<<<', '...', 32) as match_snippet
    FROM activity_fts
    JOIN activity_entries ae ON ae.id = activity_fts.rowid
    WHERE activity_fts MATCH ?
      ${extraClauses}
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

/**
 * Read the full user prompt and assistant response for a turn at a byte offset.
 *
 * Dispatches to the appropriate vendor reader based on the file path.
 * Codex transcripts live under ~/.codex/ or contain /codex/ in the path.
 */
export function readTurnContent(file: string, offset: number): TurnContent | null {
  if (file.includes('/.codex/') || file.includes('/codex/')) {
    const result = readCodexTurnContent(file, offset);
    if (!result) return null;
    return { userPrompt: result.userPrompt, assistantResponse: result.assistantResponse };
  }
  return readClaudeTurnContent(file, offset);
}

// ============================================================================
// Message-Level Query Functions
// ============================================================================

/**
 * Dual-path search over raw transcript messages (FTS5 + semantic vectors).
 *
 * Runs keyword and vector search in parallel, unions results, deduplicates
 * by message_id. Falls back to FTS5-only if embeddings are unavailable.
 */
export async function searchTranscript(
  query: string,
  limit: number = 20,
  projectId?: string,
  sessionId?: string,
  excludeSessionId?: string,
): Promise<MessageSearchResult[]> {
  return dualPathSearch(query, { limit, projectId, sessionId, excludeSessionId });
}

/**
 * Return total match count and per-session hit distribution for an FTS5 query.
 */
export function searchTranscriptMeta(
  query: string,
  projectId?: string,
  sessionId?: string,
  excludeSessionId?: string,
): MessageSearchMeta {
  return searchMessagesFtsMeta(query, projectId, sessionId, excludeSessionId);
}

/** Single turn in a context window. */
export interface MessageTurnEntry {
  message_seq: number;
  message_id: string;
  text: string;
  is_target: boolean;
  role?: string;
}

/** Result of reading a message turn with optional context window. */
export interface ReadMessageResult {
  userText: string;
  assistantText: string;
  messageSeq: number;
  /** Context window messages (only present when context > 0). */
  context_messages?: MessageTurnEntry[];
  /** Seq range shown in this response. */
  showing_seq_range?: [number, number];
  /** Total messages in this session. */
  session_total_messages?: number;
}

/**
 * Read a full conversation turn (user prompt + assistant response) by message UUID.
 *
 * Uses the messages table directly — queries adjacent rows by message_seq
 * instead of loading the full transcript from disk. Role comes from
 * `message_role` with seq-parity fallback for pre-v16 rows.
 *
 * @param context — number of extra turns on each side (0 = just the pair, max 5)
 */
export function readMessageTurn(
  sessionId: string,
  messageId: string,
  context: number = 0,
): ReadMessageResult | null {
  const record = getMessageByUuid(sessionId, messageId);
  if (!record) return null;

  const clampedContext = Math.min(Math.max(context, 0), 5);

  // Fetch the target plus its neighbor (±1 in message_seq) for the core pair
  const adjacent = getAdjacentMessages(sessionId, record.message_seq);
  if (adjacent.length === 0) return null;

  // Find target in the adjacent set
  const target = adjacent.find(m => m.message_id === messageId);
  if (!target) return null;

  // Determine the pair based on seq ordering
  const prev = adjacent.find(m => m.message_seq === target.message_seq - 1);
  const next = adjacent.find(m => m.message_seq === target.message_seq + 1);

  // Use message_role when available, fall back to seq-parity heuristic for pre-v16 rows
  const targetRole = inferRole(target.message_role, target.message_seq);
  let userText: string;
  let assistantText: string;
  if (targetRole === 'user') {
    userText = target.message_text;
    assistantText = next?.message_text ?? '';
  } else {
    userText = prev?.message_text ?? '';
    assistantText = target.message_text;
  }

  const result: ReadMessageResult = { userText, assistantText, messageSeq: target.message_seq };

  // If context window requested, fetch wider range and add metadata
  if (clampedContext > 0) {
    const windowMessages = getAdjacentMessages(sessionId, record.message_seq, clampedContext * 2);
    result.context_messages = windowMessages.map(m => ({
      message_seq: m.message_seq,
      message_id: m.message_id,
      text: m.message_text,
      is_target: m.message_id === messageId,
      role: m.message_role ?? undefined,
    }));
    if (windowMessages.length > 0) {
      result.showing_seq_range = [
        windowMessages[0]!.message_seq,
        windowMessages[windowMessages.length - 1]!.message_seq,
      ];
    }
    result.session_total_messages = getSessionMessageCount(sessionId);
  }

  return result;
}
