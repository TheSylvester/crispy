/**
 * Vector Search — Dual-path retrieval combining BM25 keyword and semantic search
 *
 * Runs FTS5 BM25 keyword search and full-corpus q8 semantic brute-force scan
 * as CO-EQUAL retrieval paths on every query. Semantic search is a first-class
 * path, not a re-ranker — it finds things keywords can't (zero keyword overlap).
 *
 * Query pipeline:
 *   1. Embed query with Nomic (~50ms, or use provided queryVector)
 *   2. Quantize query vector to q8
 *   3. Path A — BM25: FTS5 MATCH → top-128 chunk IDs (~5ms)
 *   4. Path B — Semantic: full table scan of q8 vectors, dot product, top-256 heap
 *   5. Union candidate IDs, deduplicate
 *   6. Fetch f32 vectors for union set, exact cosine rerank
 *   7. Return top-K with scores and source attribution
 *
 * Performance budget (benchmarked): ~400-600ms total for 200K vectors.
 *
 * Owns: search orchestration, score normalization, result merging.
 * Does not: persist data, manage models, own chunk content.
 *
 * @module recall/vector-search
 */

import { embed } from './embedder.js';
import { quantizeToQ8, dotProductQ8, cosineSimilarity, computeNorm } from './quantize.js';
import {
  searchChunksFts,
  getAllQ8Vectors,
  getVectorsByChunkIds,
  getChunksBySession,
  getChunkMetaByIds,
} from './store.js';
import type { ChunkRecord } from './store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  query: string;
  queryVector?: Float32Array;
  projectId?: string;
  maxAge?: number;            // max age in ms (e.g. 7 * 24 * 60 * 60 * 1000)
  topK?: number;              // default 20
  minScore?: number;          // default 0.3
}

export interface SearchResult {
  chunkId: string;
  sessionId: string;
  heading: string;
  chunkText: string;
  score: number;
  semanticScore: number;
  bm25Score: number;
  source: 'semantic' | 'bm25' | 'both';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOP_K = 20;
const DEFAULT_MIN_SCORE = 0.3;
const BM25_FETCH_LIMIT = 128;
const SEMANTIC_TOP_N = 256;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize FTS5 BM25 rank to [0, 1]. BM25 returns negative scores where
 * lower (more negative) = better match. Transform to higher = better.
 */
function normalizeBm25(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}

/**
 * Maintain a min-heap of top-N items by score. Items below the current
 * minimum are rejected without allocation.
 */
interface HeapItem {
  chunkId: string;
  score: number;
}

function pushHeap(heap: HeapItem[], item: HeapItem, maxSize: number): void {
  if (heap.length < maxSize) {
    heap.push(item);
    // Bubble up
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].score <= heap[i].score) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  } else if (item.score > heap[0].score) {
    // Replace min
    heap[0] = item;
    // Sift down
    siftDown(heap, 0);
  }
}

function siftDown(heap: HeapItem[], i: number): void {
  const n = heap.length;
  while (true) {
    let smallest = i;
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    if (left < n && heap[left].score < heap[smallest].score) smallest = left;
    if (right < n && heap[right].score < heap[smallest].score) smallest = right;
    if (smallest === i) break;
    [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
    i = smallest;
  }
}

/**
 * Build a map of chunk_id → ChunkRecord for a set of chunk IDs.
 * Fetches chunks by session to leverage the indexed query path.
 */
function fetchChunkRecords(chunkIds: Set<string>, allChunkMeta: Map<string, { sessionId: string }>): Map<string, ChunkRecord> {
  const result = new Map<string, ChunkRecord>();
  // Group by session to batch-fetch
  const bySession = new Map<string, string[]>();
  for (const cid of chunkIds) {
    const meta = allChunkMeta.get(cid);
    if (!meta) continue;
    const list = bySession.get(meta.sessionId) ?? [];
    list.push(cid);
    bySession.set(meta.sessionId, list);
  }

  for (const [sessionId, cids] of bySession) {
    const chunks = getChunksBySession(sessionId);
    const cidSet = new Set(cids);
    for (const chunk of chunks) {
      if (cidSet.has(chunk.chunk_id)) {
        result.set(chunk.chunk_id, chunk);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dual-path search: runs BM25 keyword search and semantic vector search
 * in parallel, unions results, and reranks with exact cosine similarity.
 *
 * Falls back to BM25-only if the embedding model is unavailable.
 * Falls back to semantic-only if query is empty but queryVector is provided.
 *
 * @param options  Search parameters.
 * @returns        Ranked search results with source attribution.
 */
export async function search(options: SearchOptions): Promise<SearchResult[]> {
  const {
    query,
    projectId,
    maxAge,
    topK = DEFAULT_TOP_K,
    minScore = DEFAULT_MIN_SCORE,
  } = options;

  // Edge case: no query and no vector → nothing to search
  if (!query.trim() && !options.queryVector) return [];

  const now = Date.now();

  // ------ Step 1: Get query vector ------
  let queryF32: Float32Array | null = options.queryVector ?? null;

  if (!queryF32 && query.trim()) {
    try {
      queryF32 = await embed(query);
    } catch {
      // Embedding unavailable (model not downloaded, ONNX error, etc.)
      // Fall through to BM25-only path.
    }
  }

  // ------ Step 2: Path A — BM25 keyword search ------
  const bm25Scores = new Map<string, number>();
  const bm25SessionMap = new Map<string, string>();

  if (query.trim()) {
    const bm25Results = searchChunksFts(query, BM25_FETCH_LIMIT);
    for (const r of bm25Results) {
      // Apply filters
      if (projectId && r.project_id !== projectId) continue;
      if (maxAge && (now - r.created_at) > maxAge) continue;

      const normalized = normalizeBm25(r.rank);
      bm25Scores.set(r.chunk_id, normalized);
      bm25SessionMap.set(r.chunk_id, r.session_id);
    }
  }

  // ------ Step 3: Path B — Semantic full-corpus scan ------
  const semanticScores = new Map<string, number>();

  if (queryF32) {
    const { q8: queryQ8, scale: queryScale } = quantizeToQ8(queryF32);
    const queryNorm = computeNorm(queryF32);

    if (queryNorm > 0) {
      const allVectors = getAllQ8Vectors();
      const heap: HeapItem[] = [];

      for (const row of allVectors) {
        if (row.norm === 0) continue;

        const storedQ8 = new Int8Array(
          row.embedding_q8.buffer,
          row.embedding_q8.byteOffset,
          row.embedding_q8.byteLength,
        );

        // Approximate cosine via q8 dot product
        const dotRaw = dotProductQ8(queryQ8, storedQ8);
        const approxCosine = (dotRaw * queryScale * row.quant_scale) / (queryNorm * row.norm);

        pushHeap(heap, { chunkId: row.chunk_id, score: approxCosine }, SEMANTIC_TOP_N);
      }

      // Extract heap items (session IDs will be resolved later)
      for (const item of heap) {
        semanticScores.set(item.chunkId, item.score);
      }
    }
  }

  // ------ Step 4: Union candidate IDs ------
  const candidateIds = new Set<string>();
  for (const id of bm25Scores.keys()) candidateIds.add(id);
  for (const id of semanticScores.keys()) candidateIds.add(id);

  if (candidateIds.size === 0) return [];

  // ------ Step 5: Exact cosine rerank with f32 vectors ------
  // Fetch f32 vectors for all candidates
  const vectorRecords = getVectorsByChunkIds([...candidateIds]);
  const vectorMap = new Map(vectorRecords.map(v => [v.chunk_id, v]));

  // Build session map for semantic hits (BM25 hits already have session IDs)
  // We need chunk metadata for all candidates
  const allChunkMeta = new Map<string, { sessionId: string }>();

  // BM25 results already have session IDs
  for (const [cid, sid] of bm25SessionMap) {
    allChunkMeta.set(cid, { sessionId: sid });
  }

  // For semantic-only hits, we need to look up session IDs from chunks table
  const needSessionLookup = [...candidateIds].filter(id => !allChunkMeta.has(id));
  if (needSessionLookup.length > 0) {
    // Batch-fetch chunk metadata (session_id, project_id, created_at) for filtering
    try {
      const rows = getChunkMetaByIds(needSessionLookup);
      for (const row of rows) {
        // Apply filters to semantic results
        if (projectId && row.project_id !== projectId) {
          candidateIds.delete(row.chunk_id);
          semanticScores.delete(row.chunk_id);
          continue;
        }
        if (maxAge && (now - row.created_at) > maxAge) {
          candidateIds.delete(row.chunk_id);
          semanticScores.delete(row.chunk_id);
          continue;
        }
        allChunkMeta.set(row.chunk_id, { sessionId: row.session_id });
      }
      // Remove candidates we couldn't find
      for (const id of needSessionLookup) {
        if (!allChunkMeta.has(id)) {
          candidateIds.delete(id);
          semanticScores.delete(id);
        }
      }
    } catch {
      // If DB lookup fails, remove unknown semantic hits
      for (const id of needSessionLookup) {
        candidateIds.delete(id);
        semanticScores.delete(id);
      }
    }
  }

  // Compute exact cosine similarity for candidates that have f32 vectors
  const exactScores = new Map<string, number>();
  if (queryF32) {
    const queryNorm = computeNorm(queryF32);
    for (const [chunkId, vec] of vectorMap) {
      if (!candidateIds.has(chunkId)) continue;
      const storedF32 = new Float32Array(
        vec.embedding_f32.buffer,
        vec.embedding_f32.byteOffset,
        vec.embedding_f32.byteLength / 4,
      );
      exactScores.set(chunkId, cosineSimilarity(queryF32, storedF32, queryNorm, vec.norm));
    }
  }

  // ------ Step 6: Merge scores and build results ------
  const fetchChunkIds = new Set<string>();
  for (const id of candidateIds) fetchChunkIds.add(id);

  const chunkRecords = fetchChunkRecords(fetchChunkIds, allChunkMeta);

  const results: SearchResult[] = [];
  for (const chunkId of candidateIds) {
    const chunk = chunkRecords.get(chunkId);
    if (!chunk) continue;

    const semScore = exactScores.get(chunkId) ?? semanticScores.get(chunkId) ?? 0;
    const bm25Score = bm25Scores.get(chunkId) ?? 0;

    // Final score: max of both paths
    const score = Math.max(semScore, bm25Score);
    if (score < minScore) continue;

    // Source attribution
    const inSemantic = semanticScores.has(chunkId);
    const inBm25 = bm25Scores.has(chunkId);
    const source: SearchResult['source'] =
      inSemantic && inBm25 ? 'both' :
      inSemantic ? 'semantic' : 'bm25';

    results.push({
      chunkId,
      sessionId: chunk.session_id,
      heading: chunk.heading ?? '',
      chunkText: chunk.chunk_text,
      score,
      semanticScore: semScore,
      bm25Score,
      source,
    });
  }

  // Sort by score descending, take top-K
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
