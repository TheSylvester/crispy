/**
 * Quantize — Scalar q8 quantization for embedding vectors
 *
 * Encodes float32 embedding vectors to int8 (q8) for compact storage and
 * fast approximate similarity computation. Provides encode, decode, and
 * dot-product operations.
 *
 * The q8 format maps the range [-maxAbs, +maxAbs] linearly to [-127, +127].
 * A single scalar `scale` factor (maxAbs / 127) is stored per vector,
 * enabling lossless round-trip for the dominant components and <1% error
 * for small values.
 *
 * Owns: quantization math. Pure functions, no state, no I/O.
 * Does not: persist data, load models, touch the database.
 *
 * @module recall/quantize
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Quantize a float32 vector to int8 using scalar quantization.
 *
 * @param f32  Input float32 vector (typically normalized, but not required).
 * @returns    Quantized int8 vector and the scale factor needed for dequantization.
 */
export function quantizeToQ8(f32: Float32Array): { q8: Int8Array; scale: number } {
  let maxAbs = 0;
  for (let i = 0; i < f32.length; i++) {
    const abs = Math.abs(f32[i]);
    if (abs > maxAbs) maxAbs = abs;
  }

  // Zero vector edge case — avoid division by zero.
  if (maxAbs === 0) {
    return { q8: new Int8Array(f32.length), scale: 0 };
  }

  const scale = maxAbs / 127;
  const q8 = new Int8Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    q8[i] = Math.round(f32[i] / scale);
  }
  return { q8, scale };
}

/**
 * Dequantize an int8 vector back to float32.
 *
 * @param q8     Quantized int8 vector.
 * @param scale  Scale factor from quantizeToQ8().
 * @returns      Reconstructed float32 vector (approximate).
 */
export function dequantizeQ8(q8: Int8Array, scale: number): Float32Array {
  const f32 = new Float32Array(q8.length);
  for (let i = 0; i < q8.length; i++) {
    f32[i] = q8[i] * scale;
  }
  return f32;
}

/**
 * Compute the dot product of two int8 vectors.
 *
 * Used for fast approximate cosine similarity between q8-quantized
 * embedding vectors. The result needs to be scaled by (scaleA * scaleB)
 * and divided by (normA * normB) to get cosine similarity.
 *
 * @param a  First int8 vector.
 * @param b  Second int8 vector.
 * @returns  Integer dot product (sum of element-wise products).
 */
export function dotProductQ8(a: Int8Array, b: Int8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Compute the L2 norm of a float32 vector.
 *
 * @param f32  Input float32 vector.
 * @returns    L2 norm (Euclidean length).
 */
export function computeNorm(f32: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < f32.length; i++) {
    sum += f32[i] * f32[i];
  }
  return Math.sqrt(sum);
}

/**
 * Compute exact cosine similarity between two float32 vectors with
 * pre-computed norms.
 *
 * @param a      First float32 vector.
 * @param b      Second float32 vector.
 * @param normA  Pre-computed L2 norm of a.
 * @param normB  Pre-computed L2 norm of b.
 * @returns      Cosine similarity in [-1, 1].
 */
export function cosineSimilarity(
  a: Float32Array,
  b: Float32Array,
  normA: number,
  normB: number,
): number {
  if (normA === 0 || normB === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot / (normA * normB);
}
