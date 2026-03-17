/**
 * Vector Search — Dual-path retrieval combining FTS5 keyword and semantic search
 *
 * Runs FTS5 BM25 keyword search and q8 semantic brute-force scan as
 * CO-EQUAL retrieval paths on every query. Results are merged via
 * Reciprocal Rank Fusion (RRF) with time-decayed recency weighting —
 * scale-invariant, boosts results found by both paths, and gently
 * favors recent messages.
 *
 * Query pipeline:
 *   1. Embed query with Nomic (~50ms)
 *   2. Quantize query vector to q8
 *   3. Path A — BM25: FTS5 MATCH on messages_fts
 *   4. Path B — Semantic: full table scan of message_vectors, q8 dot product
 *   5. RRF merge with recency decay — fuse ranked lists, deduplicate, take top-K
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
  /** Session ID to exclude from results (caller's own session). */
  excludeSessionId?: string;
  /** Recency decay rate. Higher = stronger preference for recent results.
   *  0 = no decay. Default 0.005 (~50% penalty at 200 days). */
  recencyDecay?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 40;
const FETCH_MULTIPLIER = 3; // fetch more from each path to improve union quality
const RRF_K = 60; // Reciprocal Rank Fusion constant — dampens top-rank dominance
const DEFAULT_RECENCY_DECAY = 0.005; // ~50% penalty at 200 days old

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
  const ftsResults = searchMessagesFts(query, fetchLimit, opts?.projectId, opts?.sessionId, opts?.excludeSessionId);

  const semanticResults = queryQ8 && queryNorm > 0
    ? searchMessagesSemantic(queryQ8, queryNorm, queryScale, {
        limit: fetchLimit,
        projectId: opts?.projectId,
        sessionId: opts?.sessionId,
        excludeSessionId: opts?.excludeSessionId,
      })
    : [];

  // RRF merge with recency decay — scale-invariant fusion of ranked lists
  const decay = opts?.recencyDecay ?? DEFAULT_RECENCY_DECAY;
  const now = Date.now();
  const rrfScores = new Map<string, { result: MessageSearchResult; score: number }>();

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i]!;
    const ageDays = (now - r.created_at) / 86_400_000;
    const recency = 1 / (1 + ageDays * decay);
    rrfScores.set(r.message_id, { result: r, score: (1 / (RRF_K + i)) * recency });
  }

  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i]!;
    const ageDays = (now - r.created_at) / 86_400_000;
    const recency = 1 / (1 + ageDays * decay);
    const rrfScore = (1 / (RRF_K + i)) * recency;
    const existing = rrfScores.get(r.message_id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      rrfScores.set(r.message_id, { result: r, score: rrfScore });
    }
  }

  const merged = [...rrfScores.values()];
  merged.sort((a, b) => b.score - a.score);

  return merged.slice(0, limit).map(m => m.result);
}
