import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock dependencies before importing vector-search
// ---------------------------------------------------------------------------

vi.mock('../../src/core/recall/message-store.js', () => ({
  searchMessagesFts: vi.fn(() => []),
  searchMessagesSemantic: vi.fn(() => []),
}));

vi.mock('../../src/core/recall/embedder.js', () => ({
  embed: vi.fn(async () => new Float32Array(768)),
}));

vi.mock('../../src/core/recall/quantize.js', async () => {
  const actual = await vi.importActual('../../src/core/recall/quantize.js');
  return actual;
});

import { searchMessagesFts, searchMessagesSemantic } from '../../src/core/recall/message-store.js';
import { embed } from '../../src/core/recall/embedder.js';
import { dualPathSearch } from '../../src/core/recall/vector-search.js';

const mockSearchFts = vi.mocked(searchMessagesFts);
const mockSearchSemantic = vi.mocked(searchMessagesSemantic);
const mockEmbed = vi.mocked(embed);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFtsResult(id: string, sessionId: string, rank: number) {
  return {
    message_id: id,
    session_id: sessionId,
    message_seq: 0,
    project_id: null,
    created_at: Date.now(),
    message_role: null,
    rank,
    match_snippet: 'test snippet',
    message_preview: 'test preview',
    truncated: false,
  };
}

function makeSemanticResult(id: string, sessionId: string, score: number) {
  return {
    message_id: id,
    session_id: sessionId,
    message_seq: 0,
    project_id: null,
    created_at: Date.now(),
    message_role: null,
    rank: -score,
    match_snippet: '',
    message_preview: 'semantic preview',
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dualPathSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for empty query', async () => {
    const results = await dualPathSearch('');
    expect(results).toEqual([]);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('returns empty array for whitespace query', async () => {
    const results = await dualPathSearch('   ');
    expect(results).toEqual([]);
  });

  it('returns FTS5-only results when embedding fails', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('model not available'));
    mockSearchFts.mockReturnValueOnce([
      makeFtsResult('m1', 's1', -5.0),
    ]);

    const results = await dualPathSearch('install deps');

    expect(results).toHaveLength(1);
    expect(results[0]!.message_id).toBe('m1');
    expect(mockSearchSemantic).not.toHaveBeenCalled();
  });

  it('runs both paths and deduplicates by message_id', async () => {
    const queryVec = new Float32Array(768);
    queryVec[0] = 1.0;
    mockEmbed.mockResolvedValueOnce(queryVec);

    // Same message found by both paths
    mockSearchFts.mockReturnValueOnce([
      makeFtsResult('m1', 's1', -5.0),
      makeFtsResult('m2', 's1', -3.0),
    ]);
    mockSearchSemantic.mockReturnValueOnce([
      makeSemanticResult('m1', 's1', 0.9),
      makeSemanticResult('m3', 's2', 0.8),
    ]);

    const results = await dualPathSearch('test query');

    // m1 appears in both, should be deduplicated (FTS takes priority)
    const ids = results.map(r => r.message_id);
    expect(ids).toContain('m1');
    expect(ids).toContain('m2');
    expect(ids).toContain('m3');
    // No duplicates
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('respects limit', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('no model'));
    mockSearchFts.mockReturnValueOnce(
      Array.from({ length: 10 }, (_, i) =>
        makeFtsResult(`m${i}`, 's1', -(10 - i)),
      ),
    );

    const results = await dualPathSearch('test', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('returns empty when no results from either path', async () => {
    mockEmbed.mockResolvedValueOnce(new Float32Array(768));
    mockSearchFts.mockReturnValueOnce([]);
    mockSearchSemantic.mockReturnValueOnce([]);

    const results = await dualPathSearch('anything');
    expect(results).toHaveLength(0);
  });

  it('passes projectId and sessionId to both paths', async () => {
    const queryVec = new Float32Array(768);
    queryVec[0] = 1.0;
    mockEmbed.mockResolvedValueOnce(queryVec);
    mockSearchFts.mockReturnValueOnce([]);
    mockSearchSemantic.mockReturnValueOnce([]);

    await dualPathSearch('test', { projectId: 'proj1', sessionId: 'sess1' });

    expect(mockSearchFts).toHaveBeenCalledWith(
      'test',
      expect.any(Number),
      'proj1',
      'sess1',
    );
    expect(mockSearchSemantic).toHaveBeenCalledWith(
      expect.any(Int8Array),
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ projectId: 'proj1', sessionId: 'sess1' }),
    );
  });
});
