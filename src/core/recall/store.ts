/**
 * Recall Store — Chunk and vector persistence for the recall pipeline
 *
 * SQLite storage for transcript chunks (FTS5-indexed) and their embedding
 * vectors (f32 + q8). Extracted from activity-index.ts to give the recall
 * subsystem its own persistence module, following the provenance/store.ts
 * pattern.
 *
 * DB access goes through crispy-db.ts; path comes from activity-index.ts.
 * Write functions ensure ~/.crispy/ exists (once); read functions assume
 * the DB is already initialized.
 *
 * @module recall/store
 */

import { getDb } from '../crispy-db.js';
import { dbPath, ensureCrispyDir } from '../activity-index.js';

// ============================================================================
// Types
// ============================================================================

/** A chunk of session transcript text, stored for FTS and embedding lookup. */
export interface ChunkRecord {
  chunk_id: string;           // UUID
  session_id: string;
  message_uuid: string | null;
  chunk_seq: number;
  heading: string | null;
  heading_level: number;
  chunk_text: string;
  project_id: string | null;
  created_at: number;         // unix timestamp ms
}

/** Embedding vectors for a chunk, in both full-precision and quantized form. */
export interface VectorRecord {
  chunk_id: string;
  embedding_f32: Buffer;      // 768 x float32 = 3,072 bytes
  embedding_q8: Buffer;       // 768 x int8 = 768 bytes
  norm: number;
  quant_scale: number;
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
 * Batch-insert chunks into the chunks table.
 * Uses a transaction for atomicity. FTS5 sync triggers fire automatically.
 */
export function insertChunks(chunks: ChunkRecord[]): void {
  if (chunks.length === 0) return;

  ensureDir();
  const d = db();

  d.exec('BEGIN');
  try {
    const stmt = d.prepare(
      `INSERT OR IGNORE INTO chunks
       (chunk_id, session_id, message_uuid, chunk_seq, heading, heading_level, chunk_text, project_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const c of chunks) {
        stmt.run([
          c.chunk_id,
          c.session_id,
          c.message_uuid,
          c.chunk_seq,
          c.heading,
          c.heading_level,
          c.chunk_text,
          c.project_id,
          c.created_at,
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
 * Batch-insert embedding vectors. Chunks must already exist (foreign key).
 * Uses INSERT OR REPLACE so re-embedding overwrites previous vectors.
 */
export function insertVectors(vectors: VectorRecord[]): void {
  if (vectors.length === 0) return;

  ensureDir();
  const d = db();

  d.exec('BEGIN');
  try {
    const stmt = d.prepare(
      `INSERT OR REPLACE INTO chunk_vectors
       (chunk_id, embedding_f32, embedding_q8, norm, quant_scale)
       VALUES (?, ?, ?, ?, ?)`,
    );
    try {
      for (const v of vectors) {
        stmt.run([
          v.chunk_id,
          v.embedding_f32,
          v.embedding_q8,
          v.norm,
          v.quant_scale,
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
// Read Functions
// ============================================================================

/**
 * Get all chunks for a session, ordered by chunk_seq.
 */
export function getChunksBySession(sessionId: string): ChunkRecord[] {
  try {
    const rows = db().all(
      `SELECT chunk_id, session_id, message_uuid, chunk_seq, heading, heading_level, chunk_text, project_id, created_at
       FROM chunks WHERE session_id = ? ORDER BY chunk_seq ASC`,
      [sessionId],
    );
    return rows.map(rowToChunk);
  } catch {
    return [];
  }
}

/**
 * Full-text search across chunk content using FTS5 BM25 ranking.
 * Returns matching chunks with their relevance rank (lower = more relevant).
 */
export function searchChunksFts(
  query: string,
  limit: number = 20,
): Array<ChunkRecord & { rank: number }> {
  try {
    const rows = db().all(
      `SELECT c.chunk_id, c.session_id, c.message_uuid, c.chunk_seq,
              c.heading, c.heading_level, c.chunk_text, c.project_id, c.created_at,
              f.rank
       FROM chunks_fts f
       JOIN chunks c ON c.rowid = f.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY f.rank
       LIMIT ?`,
      [query, limit],
    );
    return rows.map((r) => ({
      ...rowToChunk(r),
      rank: (r as Record<string, unknown>).rank as number,
    }));
  } catch {
    return [];
  }
}

/**
 * Get full-precision and quantized vectors for a set of chunk IDs.
 */
export function getVectorsByChunkIds(chunkIds: string[]): VectorRecord[] {
  if (chunkIds.length === 0) return [];

  try {
    const placeholders = chunkIds.map(() => '?').join(',');
    const rows = db().all(
      `SELECT chunk_id, embedding_f32, embedding_q8, norm, quant_scale
       FROM chunk_vectors WHERE chunk_id IN (${placeholders})`,
      chunkIds,
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        chunk_id: row.chunk_id as string,
        embedding_f32: row.embedding_f32 as Buffer,
        embedding_q8: row.embedding_q8 as Buffer,
        norm: row.norm as number,
        quant_scale: row.quant_scale as number,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get all quantized vectors for full-corpus semantic scan.
 * Returns only the fields needed for similarity computation.
 */
export function getAllQ8Vectors(): Array<{
  chunk_id: string;
  embedding_q8: Buffer;
  norm: number;
  quant_scale: number;
}> {
  try {
    const rows = db().all(
      'SELECT chunk_id, embedding_q8, norm, quant_scale FROM chunk_vectors',
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        chunk_id: row.chunk_id as string,
        embedding_q8: row.embedding_q8 as Buffer,
        norm: row.norm as number,
        quant_scale: row.quant_scale as number,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Check if a session already has chunks indexed.
 * Used to skip already-processed sessions during batch ingestion.
 */
export function hasSessionChunks(sessionId: string): boolean {
  try {
    const row = db().get(
      'SELECT 1 FROM chunks WHERE session_id = ? LIMIT 1',
      [sessionId],
    );
    return row != null;
  } catch {
    return false;
  }
}

/**
 * Delete all chunks and their vectors for a session.
 * Cascades: deletes vectors first (FK), then chunks (FTS triggers fire).
 */
export function deleteSessionChunks(sessionId: string): void {
  try {
    const d = db();
    d.exec('BEGIN');
    try {
      d.run(
        `DELETE FROM chunk_vectors WHERE chunk_id IN (
          SELECT chunk_id FROM chunks WHERE session_id = ?
        )`,
        [sessionId],
      );
      d.run('DELETE FROM chunks WHERE session_id = ?', [sessionId]);
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  } catch {
    // Non-fatal — recall is an optimization layer
  }
}

/**
 * Get chunk metadata (session_id, project_id, created_at) for a set of chunk IDs.
 * Used by vector-search to resolve session attribution for semantic hits.
 */
export function getChunkMetaByIds(chunkIds: string[]): Array<{
  chunk_id: string;
  session_id: string;
  project_id: string | null;
  created_at: number;
}> {
  if (chunkIds.length === 0) return [];

  try {
    const placeholders = chunkIds.map(() => '?').join(',');
    const rows = db().all(
      `SELECT chunk_id, session_id, project_id, created_at FROM chunks WHERE chunk_id IN (${placeholders})`,
      chunkIds,
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        chunk_id: row.chunk_id as string,
        session_id: row.session_id as string,
        project_id: (row.project_id as string) ?? null,
        created_at: row.created_at as number,
      };
    });
  } catch {
    return [];
  }
}

// ============================================================================
// Helpers
// ============================================================================

function rowToChunk(row: Record<string, unknown>): ChunkRecord {
  const r = row as Record<string, unknown>;
  return {
    chunk_id: r.chunk_id as string,
    session_id: r.session_id as string,
    message_uuid: (r.message_uuid as string) ?? null,
    chunk_seq: r.chunk_seq as number,
    heading: (r.heading as string) ?? null,
    heading_level: r.heading_level as number,
    chunk_text: r.chunk_text as string,
    project_id: (r.project_id as string) ?? null,
    created_at: r.created_at as number,
  };
}
