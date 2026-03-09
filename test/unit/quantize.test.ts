import { describe, it, expect } from 'vitest';
import {
  quantizeToQ8,
  dequantizeQ8,
  dotProductQ8,
  computeNorm,
  cosineSimilarity,
} from '../../src/core/recall/quantize.js';

describe('quantizeToQ8', () => {
  it('quantizes and dequantizes with low error', () => {
    const f32 = new Float32Array([0.5, -0.3, 0.0, 0.12, -0.95]);
    const { q8, scale } = quantizeToQ8(f32);
    const reconstructed = dequantizeQ8(q8, scale);

    for (let i = 0; i < f32.length; i++) {
      expect(reconstructed[i]).toBeCloseTo(f32[i], 1); // within 0.05
    }
  });

  it('maps the largest magnitude to ±127', () => {
    const f32 = new Float32Array([0.0, 1.0, -0.5, 0.25]);
    const { q8 } = quantizeToQ8(f32);

    // 1.0 is the max abs, should map to 127
    expect(q8[1]).toBe(127);
    // -0.5 should map to ~-64
    expect(q8[2]).toBeGreaterThanOrEqual(-65);
    expect(q8[2]).toBeLessThanOrEqual(-63);
  });

  it('handles zero vector', () => {
    const f32 = new Float32Array([0, 0, 0, 0]);
    const { q8, scale } = quantizeToQ8(f32);

    expect(scale).toBe(0);
    for (let i = 0; i < q8.length; i++) {
      expect(q8[i]).toBe(0);
    }
  });

  it('handles single-element vector', () => {
    const f32 = new Float32Array([0.42]);
    const { q8, scale } = quantizeToQ8(f32);
    expect(q8[0]).toBe(127);
    expect(scale).toBeCloseTo(0.42 / 127, 6);
  });

  it('preserves relative ordering', () => {
    const values = [0.1, 0.5, 0.3, 0.9, 0.7];
    const f32 = new Float32Array(values);
    const { q8 } = quantizeToQ8(f32);

    // q8 values should maintain the same ordering
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        if (values[i] < values[j]) {
          expect(q8[i]).toBeLessThanOrEqual(q8[j]);
        } else if (values[i] > values[j]) {
          expect(q8[i]).toBeGreaterThanOrEqual(q8[j]);
        }
      }
    }
  });

  it('handles negative-only vectors', () => {
    const f32 = new Float32Array([-0.8, -0.2, -0.5]);
    const { q8, scale } = quantizeToQ8(f32);
    const reconstructed = dequantizeQ8(q8, scale);

    for (let i = 0; i < f32.length; i++) {
      expect(reconstructed[i]).toBeCloseTo(f32[i], 1);
    }
  });
});

describe('dequantizeQ8', () => {
  it('reconstructs zero vector with zero scale', () => {
    const q8 = new Int8Array([0, 0, 0]);
    const result = dequantizeQ8(q8, 0);
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBe(0);
    }
  });

  it('round-trips a normalized-ish vector', () => {
    // Simulate a roughly normalized 768-dim vector
    const dim = 768;
    const f32 = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      f32[i] = (Math.sin(i * 0.1) * 0.05); // small values typical of normalized vectors
    }
    const { q8, scale } = quantizeToQ8(f32);
    const reconstructed = dequantizeQ8(q8, scale);

    // Max error should be within one quantization step
    const maxStep = scale;
    for (let i = 0; i < dim; i++) {
      expect(Math.abs(reconstructed[i] - f32[i])).toBeLessThanOrEqual(maxStep + 1e-7);
    }
  });
});

describe('dotProductQ8', () => {
  it('computes correct dot product', () => {
    const a = new Int8Array([1, 2, 3]);
    const b = new Int8Array([4, 5, 6]);
    // 1*4 + 2*5 + 3*6 = 4 + 10 + 18 = 32
    expect(dotProductQ8(a, b)).toBe(32);
  });

  it('handles negative values', () => {
    const a = new Int8Array([1, -2, 3]);
    const b = new Int8Array([-4, 5, -6]);
    // 1*(-4) + (-2)*5 + 3*(-6) = -4 + -10 + -18 = -32
    expect(dotProductQ8(a, b)).toBe(-32);
  });

  it('handles zero vectors', () => {
    const a = new Int8Array([0, 0, 0]);
    const b = new Int8Array([1, 2, 3]);
    expect(dotProductQ8(a, b)).toBe(0);
  });

  it('handles max values', () => {
    const a = new Int8Array([127, 127]);
    const b = new Int8Array([127, 127]);
    // 127*127 + 127*127 = 16129 + 16129 = 32258
    expect(dotProductQ8(a, b)).toBe(32258);
  });
});

describe('computeNorm', () => {
  it('computes L2 norm', () => {
    const f32 = new Float32Array([3, 4]);
    expect(computeNorm(f32)).toBeCloseTo(5, 6);
  });

  it('returns 0 for zero vector', () => {
    const f32 = new Float32Array([0, 0, 0]);
    expect(computeNorm(f32)).toBe(0);
  });

  it('returns 1 for unit vector', () => {
    const f32 = new Float32Array([1, 0, 0]);
    expect(computeNorm(f32)).toBeCloseTo(1, 6);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const norm = computeNorm(a);
    expect(cosineSimilarity(a, a, norm, norm)).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b, computeNorm(a), computeNorm(b))).toBeCloseTo(0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b, computeNorm(a), computeNorm(b))).toBeCloseTo(-1, 6);
  });

  it('returns 0 when a norm is zero', () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([1, 2]);
    expect(cosineSimilarity(a, b, 0, computeNorm(b))).toBe(0);
  });

  it('is scale-invariant', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]); // 2x of a
    const sim = cosineSimilarity(a, b, computeNorm(a), computeNorm(b));
    expect(sim).toBeCloseTo(1, 6);
  });
});

describe('q8 approximate cosine vs exact cosine', () => {
  it('q8 cosine approximation is close to exact', () => {
    // Create two random-ish 768-dim vectors
    const dim = 768;
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      a[i] = Math.sin(i * 0.1) * 0.05;
      b[i] = Math.cos(i * 0.07) * 0.04;
    }

    // Exact cosine
    const normA = computeNorm(a);
    const normB = computeNorm(b);
    const exact = cosineSimilarity(a, b, normA, normB);

    // Q8 approximate cosine
    const { q8: q8A, scale: scaleA } = quantizeToQ8(a);
    const { q8: q8B, scale: scaleB } = quantizeToQ8(b);
    const dotRaw = dotProductQ8(q8A, q8B);
    const approx = (dotRaw * scaleA * scaleB) / (normA * normB);

    // Should be within 5% of exact
    expect(Math.abs(approx - exact)).toBeLessThan(0.05);
  });
});
