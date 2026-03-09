/**
 * Embedder — Lazy-loading Nomic Embed Code embedding pipeline
 *
 * Generates dense vector embeddings for text using Nomic Embed Code via
 * @huggingface/transformers. The model downloads on first use (~270 MB)
 * and is cached by HuggingFace's default cache mechanism.
 *
 * Uses the same lazy-load + coalesced promise pattern as voice-engine.ts:
 * concurrent callers share a single model download, and subsequent calls
 * are instant.
 *
 * Owns: model lifecycle, text-to-embedding conversion.
 * Does not: persist embeddings, manage chunks, touch ~/.crispy/.
 *
 * @module recall/embedder
 */

// Lazy-imported to avoid pulling onnxruntime-node native bindings at
// import time (crashes VS Code's Electron extension host).

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL_ID = 'Xenova/nomic-embed-text-v1';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Cached pipeline instance — non-null once model is loaded. */
let embedder: any = null;

/** Deduplication guard so concurrent callers share a single load. */
let loading: Promise<any> | null = null;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Lazy-load the Nomic Embed Code pipeline. Concurrent calls coalesce into
 * one promise so the model is only downloaded once.
 */
async function getEmbedder(): Promise<any> {
  if (embedder) return embedder;

  if (!loading) {
    loading = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');

        // Disable WASM proxy (safe for Node, matches voice-engine.ts).
        if (env.backends.onnx.wasm) {
          env.backends.onnx.wasm.proxy = false;
        }

        const model = await pipeline('feature-extraction', MODEL_ID);

        embedder = model;
        return model;
      } catch (err) {
        // Reset so a subsequent call can retry.
        loading = null;
        throw err;
      }
    })();
  }

  embedder = await loading;
  return embedder;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed a single text string into a normalized 768-dimensional vector.
 *
 * The model is lazy-loaded on first call. Subsequent calls reuse the
 * cached pipeline instance.
 *
 * @param text  The text to embed (code snippet, markdown chunk, query, etc.)
 * @returns     Normalized float32 embedding vector (768 dimensions).
 */
export async function embed(text: string): Promise<Float32Array> {
  const model = await getEmbedder();
  const result = await model(text, { pooling: 'mean', normalize: true });
  return result.data as Float32Array;
}

/**
 * Embed multiple texts in a single batch call.
 *
 * More efficient than calling embed() in a loop when processing many chunks.
 *
 * @param texts  Array of text strings to embed.
 * @returns      Array of normalized float32 embedding vectors.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const model = await getEmbedder();

  const results: Float32Array[] = [];
  for (const text of texts) {
    const result = await model(text, { pooling: 'mean', normalize: true });
    results.push(result.data as Float32Array);
  }
  return results;
}
