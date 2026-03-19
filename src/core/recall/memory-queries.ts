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
 * @module core/recall/memory-queries
 */

import { getDb } from '../crispy-db.js';
import { dbPath as crispyDbPath } from '../activity-index.js';
import { readClaudeTurnContent, type TurnContent } from '../adapters/claude/jsonl-reader.js';
import { readCodexTurnContent } from '../adapters/codex/codex-jsonl-reader.js';
import { searchMessagesFtsMeta, getMessageByUuid, getAdjacentMessages, getSessionMessageCount, grepMessages, readSessionMessages, inferRole } from './message-store.js';
import type { MessageRecord, MessageSearchResult, MessageSearchMeta, GrepMatch, SessionPage } from './message-store.js';
import { dualPathSearch } from './vector-search.js';
import type { DualPathSearchResult } from './vector-search.js';

export type { TurnContent, MessageRecord, MessageSearchResult, MessageSearchMeta, GrepMatch, SessionPage, DualPathSearchResult };
export { grepMessages, readSessionMessages };

// ============================================================================
// Types
// ============================================================================

export interface ListResult {
  session_id: string;
  first_activity: number;  // epoch ms
  last_activity: number;   // epoch ms
  message_count: number;
  title: string | null;
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
 * List distinct sessions ordered by most recent activity.
 *
 * Queries the `messages` table and enriches with session titles.
 *
 * @param excludeSessionId - Optional session ID to exclude from results (e.g., caller's own session)
 */
export function listSessions(
  dbPath: string,
  limit: number = 50,
  since?: string,
  excludeSessionId?: string,
): ListResult[] {
  const db = getDb(dbPath);
  const params: (string | number)[] = [];
  const conditions: string[] = [];

  if (since) {
    // messages.created_at is INTEGER (epoch ms) — convert ISO string to epoch ms
    const sinceMs = new Date(since).getTime();
    conditions.push('m.created_at >= ?');
    params.push(sinceMs);
  }
  if (excludeSessionId) {
    conditions.push('m.session_id != ?');
    params.push(excludeSessionId);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit);

  return db.all(`
    SELECT m.session_id,
           MIN(m.created_at) as first_activity,
           MAX(m.created_at) as last_activity,
           COUNT(*) as message_count,
           t.title
    FROM messages m
    LEFT JOIN session_titles t ON t.session_id = m.session_id
    ${whereClause}
    GROUP BY m.session_id
    ORDER BY last_activity DESC
    LIMIT ?
  `, params) as unknown as ListResult[];
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
 *
 * Returns the full DualPathSearchResult including semantic availability metadata.
 */
export async function searchTranscript(
  query: string,
  limit: number = 20,
  projectId?: string,
  sessionId?: string,
  excludeSessionId?: string,
): Promise<DualPathSearchResult> {
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
