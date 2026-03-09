/**
 * Ingest — Per-session transcript processing for the recall pipeline
 *
 * Reads a Claude Code JSONL transcript, strips tool content, concatenates
 * user/assistant text, chunks by markdown headers, and stores in SQLite.
 * FTS5 indexing happens automatically via triggers on insert.
 *
 * Embedding is optional (--with-embeddings). When enabled, each chunk is
 * embedded with Nomic Embed Code, quantized to q8, and stored alongside
 * the chunk. When disabled (default), only chunks + FTS5 are populated.
 *
 * Designed for both real-time (single session) and batch (backfill) use.
 *
 * Owns: session-level ingestion orchestration.
 * Does not: discover sessions, manage concurrency, own CLI parsing.
 *
 * @module recall/ingest
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { chunkMarkdown } from './markdown-chunker.js';
import { stripToolContent } from './transcript-utils.js';
import {
  insertChunks,
  insertVectors,
  hasSessionChunks,
  deleteSessionChunks,
} from './store.js';
import type { ChunkRecord, VectorRecord } from './store.js';
import type { TranscriptEntry } from '../transcript.js';

// ============================================================================
// Types
// ============================================================================

export interface IngestResult {
  sessionId: string;
  chunksCreated: number;
  skipped: boolean;       // true if session already processed
  error?: string;
}

export interface IngestOptions {
  projectId?: string;
  force?: boolean;
  verbose?: boolean;
  /** When true, embed each chunk with Nomic and store vectors. Default: false (FTS5 only). */
  withEmbeddings?: boolean;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Parse a JSONL file into an array of transcript entries.
 * Skips blank lines and lines that fail JSON.parse.
 */
function parseJsonl(filePath: string): TranscriptEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.trim()) return [];

  const entries: TranscriptEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Extract text from stripped transcript entries into a single markdown string.
 * Concatenates all text blocks from user/assistant messages, separated by
 * double newlines. Returns empty string if no text content remains.
 */
export function entriesToText(entries: TranscriptEntry[]): string {
  const parts: string[] = [];

  for (const entry of entries) {
    const msg = entry.message;
    if (!msg) continue;

    if (typeof msg.content === 'string') {
      const trimmed = msg.content.trim();
      if (trimmed) parts.push(trimmed);
      continue;
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          const text = (block as { text?: string }).text?.trim();
          if (text) parts.push(text);
        }
      }
    }
  }

  return parts.join('\n\n');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Process a single session transcript file through the full ingestion pipeline:
 *   1. Extract session ID from filename
 *   2. Check if already processed (skip unless force)
 *   3. Parse JSONL, strip tool content
 *   4. Concatenate text, chunk by markdown headers
 *   5. Embed each chunk, quantize to q8
 *   6. Store chunks and vectors in SQLite
 *
 * @param sessionPath  Absolute path to the .jsonl session file.
 * @param options      Processing options.
 * @returns            Result with session ID, chunk count, and skip/error status.
 */
export async function ingestSession(
  sessionPath: string,
  options?: IngestOptions,
): Promise<IngestResult> {
  const sessionId = path.basename(sessionPath, '.jsonl');

  // 1. Check if already processed
  if (!options?.force && hasSessionChunks(sessionId)) {
    return { sessionId, chunksCreated: 0, skipped: true };
  }

  // 2. Read and parse JSONL
  let rawEntries: TranscriptEntry[];
  try {
    rawEntries = parseJsonl(sessionPath);
  } catch (err) {
    return {
      sessionId,
      chunksCreated: 0,
      skipped: false,
      error: `Failed to read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (rawEntries.length === 0) {
    return { sessionId, chunksCreated: 0, skipped: true };
  }

  // 3. Strip tool content, keep only user/assistant text
  const filtered = stripToolContent(rawEntries);
  const text = entriesToText(filtered);

  if (!text.trim()) {
    return { sessionId, chunksCreated: 0, skipped: true };
  }

  // 4. Chunk by markdown headers
  const markdownChunks = chunkMarkdown(text, { maxChunkSize: 2000 });

  if (markdownChunks.length === 0) {
    return { sessionId, chunksCreated: 0, skipped: true };
  }

  // 5. If force, clear existing chunks first
  if (options?.force && hasSessionChunks(sessionId)) {
    deleteSessionChunks(sessionId);
  }

  // 6. Build chunk records; optionally embed each chunk
  const chunkRecords: ChunkRecord[] = [];
  const vectorRecords: VectorRecord[] = [];
  const now = Date.now();
  const doEmbed = !!options?.withEmbeddings;

  // Lazy-import embedding modules only when needed
  let embedFn: ((text: string) => Promise<Float32Array>) | null = null;
  let quantizeFn: ((f32: Float32Array) => { q8: Int8Array; scale: number }) | null = null;
  let normFn: ((f32: Float32Array) => number) | null = null;

  if (doEmbed) {
    const { embed } = await import('./embedder.js');
    const { quantizeToQ8, computeNorm } = await import('./quantize.js');
    embedFn = embed;
    quantizeFn = quantizeToQ8;
    normFn = computeNorm;
  }

  for (const chunk of markdownChunks) {
    const chunkId = crypto.randomUUID();

    const chunkRecord: ChunkRecord = {
      chunk_id: chunkId,
      session_id: sessionId,
      message_uuid: null,
      chunk_seq: chunk.index,
      heading: chunk.heading || null,
      heading_level: chunk.headingLevel,
      chunk_text: chunk.text,
      project_id: options?.projectId || null,
      created_at: now,
    };

    chunkRecords.push(chunkRecord);

    if (doEmbed && embedFn && quantizeFn && normFn) {
      try {
        const f32 = await embedFn(chunk.text);
        const { q8, scale } = quantizeFn(f32);
        const norm = normFn(f32);

        vectorRecords.push({
          chunk_id: chunkId,
          embedding_f32: Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
          embedding_q8: Buffer.from(q8.buffer, q8.byteOffset, q8.byteLength),
          norm,
          quant_scale: scale,
        });
      } catch (err) {
        if (options?.verbose) {
          console.error(`  [ingest] Chunk ${chunk.index} embed error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // 7. Batch insert — chunks first (FK parent), then vectors
  try {
    insertChunks(chunkRecords);
    if (vectorRecords.length > 0) {
      insertVectors(vectorRecords);
    }
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
    chunksCreated: chunkRecords.length,
    skipped: false,
  };
}
