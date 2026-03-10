import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quantizeToQ8, computeNorm } from '../../src/core/recall/quantize.js';

// ---------------------------------------------------------------------------
// Mock recall/store before importing vector-search
// ---------------------------------------------------------------------------

vi.mock('../../src/core/recall/store.js', () => ({
  searchChunksFts: vi.fn(() => []),
  getAllQ8Vectors: vi.fn(() => []),
  getVectorsByChunkIds: vi.fn(() => []),
  getChunksBySession: vi.fn(() => []),
  getChunkMetaByIds: vi.fn(() => []),
}));

vi.mock('../../src/core/recall/embedder.js', () => ({
  embed: vi.fn(async () => new Float32Array(768)),
}));

// Import mocked modules
import {
  searchChunksFts,
  getAllQ8Vectors,
  getVectorsByChunkIds,
  getChunksBySession,
  getChunkMetaByIds,
} from '../../src/core/recall/store.js';
import { embed } from '../../src/core/recall/embedder.js';
import { search } from '../../src/core/recall/vector-search.js';


const mockSearchChunksFts = vi.mocked(searchChunksFts);
const mockGetAllQ8Vectors = vi.mocked(getAllQ8Vectors);
const mockGetVectorsByChunkIds = vi.mocked(getVectorsByChunkIds);
const mockGetChunksBySession = vi.mocked(getChunksBySession);
const mockEmbed = vi.mocked(embed);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake 768-dim vector with a distinctive pattern. */
function makeVector(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    v[i] = Math.sin(i * 0.1 + seed) * 0.05;
  }
  // Normalize
  const norm = computeNorm(v);
  for (let i = 0; i < 768; i++) v[i] /= norm;
  return v;
}

function makeChunkRecord(id: string, sessionId: string, heading: string, text: string) {
  return {
    chunk_id: id,
    session_id: sessionId,
    message_uuid: null,
    chunk_seq: 0,
    heading,
    heading_level: 1,
    chunk_text: text,
    project_id: null,
    created_at: Date.now(),
  };
}

function makeQ8Row(chunkId: string, vector: Float32Array) {
  const { q8, scale } = quantizeToQ8(vector);
  const norm = computeNorm(vector);
  return {
    chunk_id: chunkId,
    embedding_q8: Buffer.from(q8.buffer, q8.byteOffset, q8.byteLength),
    norm,
    quant_scale: scale,
  };
}

function makeVectorRecord(chunkId: string, vector: Float32Array) {
  const { q8, scale } = quantizeToQ8(vector);
  const norm = computeNorm(vector);
  return {
    chunk_id: chunkId,
    embedding_f32: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    embedding_q8: Buffer.from(q8.buffer, q8.byteOffset, q8.byteLength),
    norm,
    quant_scale: scale,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for empty query with no vector', async () => {
    const results = await search({ query: '' });
    expect(results).toEqual([]);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('returns empty array for whitespace query', async () => {
    const results = await search({ query: '   ' });
    expect(results).toEqual([]);
  });

  it('returns BM25-only results when embedding fails', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('model not available'));

    const chunk = makeChunkRecord('c1', 's1', 'Setup', 'Install dependencies');
    mockSearchChunksFts.mockReturnValueOnce([
      { ...chunk, rank: -5.0 },
    ]);
    mockGetChunksBySession.mockReturnValueOnce([chunk]);

    const results = await search({ query: 'install deps', minScore: 0 });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('bm25');
    expect(results[0].chunkId).toBe('c1');
    expect(results[0].bm25Score).toBeGreaterThan(0);
    expect(results[0].semanticScore).toBe(0);
  });

  it('returns semantic-only results with queryVector and empty query', async () => {
    const queryVec = makeVector(42);
    const similarVec = makeVector(42.1); // very similar
    const dissimilarVec = makeVector(100); // different

    mockGetAllQ8Vectors.mockReturnValueOnce([
      makeQ8Row('c1', similarVec),
      makeQ8Row('c2', dissimilarVec),
    ]);

    const chunk1 = makeChunkRecord('c1', 's1', 'Similar', 'similar content');
    const chunk2 = makeChunkRecord('c2', 's2', 'Different', 'different content');

    mockGetVectorsByChunkIds.mockReturnValueOnce([
      makeVectorRecord('c1', similarVec),
      makeVectorRecord('c2', dissimilarVec),
    ]);
    mockGetChunksBySession.mockImplementation((sid) => {
      if (sid === 's1') return [chunk1];
      if (sid === 's2') return [chunk2];
      return [];
    });

    // Mock chunk metadata lookup for semantic hit session IDs
    const mockGetChunkMetaByIds = vi.mocked(getChunkMetaByIds);
    mockGetChunkMetaByIds.mockReturnValueOnce([
      { chunk_id: 'c1', session_id: 's1', project_id: null, created_at: Date.now() },
      { chunk_id: 'c2', session_id: 's2', project_id: null, created_at: Date.now() },
    ]);

    const results = await search({
      query: '',
      queryVector: queryVec,
      minScore: 0,
    });

    // Should have results, with the similar one ranked higher
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('semantic');
    // BM25 should not run (empty query)
    expect(mockSearchChunksFts).not.toHaveBeenCalled();
  });

  it('respects topK limit', async () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makeChunkRecord(`c${i}`, 's1', `Heading ${i}`, `Content ${i}`),
    );

    mockSearchChunksFts.mockReturnValueOnce(
      chunks.map((c, i) => ({ ...c, rank: -(10 - i) })),
    );
    mockEmbed.mockRejectedValueOnce(new Error('no model'));
    mockGetChunksBySession.mockReturnValueOnce(chunks);

    const results = await search({ query: 'test', topK: 3, minScore: 0 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('filters by minScore', async () => {
    const chunk = makeChunkRecord('c1', 's1', 'Weak', 'weak match');
    // BM25 rank of -0.1 → normalized ≈ 0.91 — passes high minScore
    // BM25 rank of -100 → normalized ≈ 0.0099 — fails high minScore
    mockSearchChunksFts.mockReturnValueOnce([
      { ...chunk, rank: -100 }, // normalized ≈ 0.0099
    ]);
    mockEmbed.mockRejectedValueOnce(new Error('no model'));
    mockGetChunksBySession.mockReturnValueOnce([chunk]);

    const results = await search({ query: 'test', minScore: 0.5 });
    expect(results).toHaveLength(0);
  });

  it('returns empty when no chunks exist', async () => {
    mockSearchChunksFts.mockReturnValueOnce([]);
    mockGetAllQ8Vectors.mockReturnValueOnce([]);
    mockEmbed.mockResolvedValueOnce(makeVector(1));

    const results = await search({ query: 'anything' });
    expect(results).toHaveLength(0);
  });

  it('attributes source as "both" when found by both paths', async () => {
    const vec = makeVector(7);
    const chunk = makeChunkRecord('c1', 's1', 'Both', 'found by both paths');

    // BM25 finds it
    mockSearchChunksFts.mockReturnValueOnce([{ ...chunk, rank: -5 }]);

    // Semantic also finds it — use same vector as query
    mockEmbed.mockResolvedValueOnce(vec);
    mockGetAllQ8Vectors.mockReturnValueOnce([makeQ8Row('c1', vec)]);
    mockGetVectorsByChunkIds.mockReturnValueOnce([makeVectorRecord('c1', vec)]);
    mockGetChunksBySession.mockReturnValueOnce([chunk]);

    const results = await search({ query: 'found by both', minScore: 0 });

    expect(results.length).toBeGreaterThan(0);
    const r = results.find(r => r.chunkId === 'c1');
    expect(r).toBeDefined();
    expect(r!.source).toBe('both');
    expect(r!.semanticScore).toBeGreaterThan(0);
    expect(r!.bm25Score).toBeGreaterThan(0);
  });
});
