/**
 * Message Ingest — Per-session message-level ingestion for the recall pipeline
 *
 * Loads a session through the vendor adapter, strips tool content, and stores
 * one row per user/assistant entry in the messages table. FTS5 indexing
 * happens automatically via triggers on insert.
 *
 * Also handles semantic embedding: after messages are indexed, they can be
 * embedded with Nomic Embed Code and stored as q8 vectors for dual-path search.
 *
 * Preserves message boundaries and uses the entry's uuid as the primary key.
 * Sub-agent entries (those with parentToolUseID) are excluded — the parent
 * session's assistant entries already contain sub-agent output via the Task
 * tool result.
 *
 * Also owns the IngestResult/IngestOptions types used by both this module
 * and the backfill CLI.
 *
 * Designed for both real-time (single session) and batch (backfill) use.
 *
 * Owns: session-level message ingestion + embedding orchestration, ingest types.
 * Does not: discover sessions, manage concurrency, own CLI parsing.
 *
 * @module recall/message-ingest
 */

import { stripToolContent } from './transcript-utils.js';
import {
  insertMessages,
  insertMessageVectors,
  hasSessionMessages,
  deleteSessionMessages,
} from './message-store.js';
import type { MessageRecord, MessageVectorRecord } from './message-store.js';
import { getDb } from '../crispy-db.js';
import { dbPath } from '../activity-index.js';
import { findSession, loadSession } from '../session-manager.js';
import type { TranscriptEntry } from '../transcript.js';

// ============================================================================
// Types (originally from ingest.ts, moved here after chunk pipeline removal)
// ============================================================================

export interface IngestResult {
  sessionId: string;
  chunksCreated: number;
  skipped: boolean;
  error?: string;
}

export interface IngestOptions {
  projectId?: string;
  force?: boolean;
  verbose?: boolean;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract text content from a single transcript entry.
 *
 * Handles both string and array content formats. For array content, joins
 * only text blocks (filtering out tool_use, tool_result, thinking, etc.).
 * Returns empty string if no text content remains.
 */
export function extractEntryText(entry: TranscriptEntry): string {
  const msg = entry.message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => (b as { text?: string }).text?.trim())
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/**
 * Ingest a session's messages into the message-level recall index.
 *
 * Flow:
 *   1. Check if already processed (skip unless force)
 *   2. Resolve session info for project_id
 *   3. Load entries through the vendor adapter
 *   4. Strip tool content, filter sub-agent entries
 *   5. Extract text per entry, build MessageRecords
 *   6. Batch insert into SQLite (FTS5 triggers fire automatically)
 *
 * @param sessionId  The session ID to ingest.
 * @param options    Processing options (force, verbose, projectId).
 * @returns          Result with session ID, message count, and skip/error status.
 */
export async function ingestSessionMessages(
  sessionId: string,
  options?: IngestOptions,
): Promise<IngestResult> {
  // 1. Check if already processed
  if (!options?.force && hasSessionMessages(sessionId)) {
    return { sessionId, chunksCreated: 0, skipped: true };
  }

  // 2. Resolve session info for project_id
  const sessionInfo = findSession(sessionId);
  const projectId = options?.projectId ?? sessionInfo?.projectPath ?? null;

  // 3. Load entries through the vendor adapter
  let rawEntries: TranscriptEntry[];
  try {
    rawEntries = await loadSession(sessionId);
  } catch (err) {
    return {
      sessionId,
      chunksCreated: 0,
      skipped: false,
      error: `Failed to load session: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (rawEntries.length === 0) {
    return { sessionId, chunksCreated: 0, skipped: true };
  }

  // 4. Strip tool content, filter sub-agent entries
  const filtered = stripToolContent(rawEntries);
  const topLevel = filtered.filter(e => !e.parentToolUseID);

  // 5. Extract text per entry, build MessageRecords
  const now = Date.now();
  const records: MessageRecord[] = [];

  for (let i = 0; i < topLevel.length; i++) {
    const entry = topLevel[i]!;

    // Skip entries without uuid — can't be the PK
    if (!entry.uuid) continue;

    const text = extractEntryText(entry);
    if (!text) continue;

    records.push({
      message_id: entry.uuid,
      session_id: sessionId,
      message_seq: i,
      message_text: text,
      project_id: projectId,
      created_at: now,
    });
  }

  if (records.length === 0) {
    return { sessionId, chunksCreated: 0, skipped: true };
  }

  // 6. If force, clear existing messages first (delete is idempotent)
  if (options?.force) {
    deleteSessionMessages(sessionId);
  }

  // 7. Batch insert
  try {
    insertMessages(records);
  } catch (err) {
    return {
      sessionId,
      chunksCreated: 0,
      skipped: false,
      error: `DB insert failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    sessionId,
    chunksCreated: records.length,
    skipped: false,
  };
}

// ============================================================================
// Semantic Embedding
// ============================================================================

/** Max characters to embed per message (Nomic has 8192 token limit, ~4 chars/token). */
const MAX_EMBED_CHARS = 32_000;

/**
 * Embed a session's indexed messages into q8 vectors for semantic search.
 *
 * Reads messages from the DB (must already be FTS5-indexed), embeds each
 * with Nomic Embed Code, quantizes to q8, and batch-inserts into
 * message_vectors. Skips messages that already have vectors unless force.
 *
 * The embedding model is lazy-loaded on first call (~2-10s). Subsequent
 * calls reuse the cached model (~200ms/msg on CPU).
 *
 * @param sessionId  The session to embed (must already have messages indexed).
 * @param force      Re-embed even if vectors already exist for this session.
 * @returns          Number of messages embedded, or 0 if skipped/failed.
 */
export async function embedSessionMessages(
  sessionId: string,
  force?: boolean,
): Promise<number> {
  const d = getDb(dbPath());

  // Skip if already embedded (unless force)
  if (!force) {
    const existing = d.get(
      `SELECT 1 FROM message_vectors mv
       JOIN messages m ON m.message_id = mv.message_id
       WHERE m.session_id = ? LIMIT 1`,
      [sessionId],
    );
    if (existing) return 0;
  }

  // Read messages for this session
  const rows = d.all(
    `SELECT message_id, message_text FROM messages WHERE session_id = ? ORDER BY message_seq ASC`,
    [sessionId],
  ) as Array<Record<string, unknown>>;

  const validRows: Array<{ messageId: string; text: string }> = [];
  for (const r of rows) {
    const text = (r.message_text as string).trim();
    if (!text) continue;
    validRows.push({
      messageId: r.message_id as string,
      text: text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text,
    });
  }
  if (validRows.length === 0) return 0;

  // Lazy-load embedding modules
  const { embedBatch } = await import('./embedder.js');
  const { quantizeToQ8, computeNorm } = await import('./quantize.js');

  // Embed
  const texts = validRows.map(r => r.text);
  const vectors = await embedBatch(texts);

  // Quantize and build records
  const records: MessageVectorRecord[] = [];
  for (let j = 0; j < validRows.length; j++) {
    const f32 = vectors[j]!;
    const { q8, scale } = quantizeToQ8(f32);
    const norm = computeNorm(f32);
    records.push({
      messageId: validRows[j]!.messageId,
      embeddingQ8: q8,
      norm,
      quantScale: scale,
    });
  }

  // Insert
  insertMessageVectors(records);
  return records.length;
}
