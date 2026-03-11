/**
 * Vector Search — Dual-path retrieval combining FTS5 keyword and semantic search
 *
 * Runs FTS5 BM25 keyword search and q8 semantic brute-force scan as
 * CO-EQUAL retrieval paths on every query. Results are unioned and
 * deduplicated by message_id.
 *
 * Query pipeline:
 *   1. Embed query with Nomic (~50ms)
 *   2. Quantize query vector to q8
 *   3. Path A — BM25: FTS5 MATCH on messages_fts
 *   4. Path B — Semantic: full table scan of message_vectors, q8 dot product
 *   5. Union results, deduplicate by message_id, take top-K
 *
 * Owns: search orchestration, result merging.
 * Does not: persist data, manage models.
 *
 * @module recall/vector-search
 */

import { embed } from './embedder.js';
import { quantizeToQ8, computeNorm } from './quantize.js';
import { searchMessagesFts, searchMessagesSemantic } from './message-store.js';
import type { MessageSearchResult } from './message-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DualPathSearchOptions {
  limit?: number;
  projectId?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const FETCH_MULTIPLIER = 3; // fetch more from each path to improve union quality

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dual-path search: runs FTS5 keyword search and semantic vector search,
 * unions results, and deduplicates by message_id.
 *
 * If the embedding model is unavailable, falls back to FTS5-only.
 * If message_vectors is empty, the semantic path returns nothing and
 * FTS5 results are used alone.
 */
export async function dualPathSearch(
  query: string,
  opts?: DualPathSearchOptions,
): Promise<MessageSearchResult[]> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const fetchLimit = limit * FETCH_MULTIPLIER;

  if (!query.trim()) return [];

  // Embed the query and quantize
  let queryQ8: Int8Array | null = null;
  let queryNorm = 0;
  let queryScale = 0;

  try {
    const queryF32 = await embed(query);
    queryNorm = computeNorm(queryF32);
    const quantized = quantizeToQ8(queryF32);
    queryQ8 = quantized.q8;
    queryScale = quantized.scale;
  } catch {
    // Embedding unavailable — fall through to FTS5-only
  }

  // Run both paths (both are synchronous SQLite operations)
  const ftsResults = searchMessagesFts(query, fetchLimit, opts?.projectId, opts?.sessionId);

  const semanticResults = queryQ8 && queryNorm > 0
    ? searchMessagesSemantic(queryQ8, queryNorm, queryScale, {
        limit: fetchLimit,
        projectId: opts?.projectId,
        sessionId: opts?.sessionId,
      })
    : [];

  // Union + dedup by message_id (FTS5 results take priority for rank/snippet)
  const seen = new Map<string, MessageSearchResult>();

  for (const r of ftsResults) {
    seen.set(r.message_id, r);
  }

  for (const r of semanticResults) {
    if (!seen.has(r.message_id)) {
      seen.set(r.message_id, r);
    }
  }

  // Sort by rank (lower = better for FTS5; semantic uses negative cosine)
  const merged = [...seen.values()];
  merged.sort((a, b) => a.rank - b.rank);

  return merged.slice(0, limit);
}
