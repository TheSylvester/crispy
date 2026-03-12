/**
 * Embed Worker — Child process entry point for ONNX embedding inference
 *
 * Isolates the ONNX runtime (which leaks ~100 MB/s of native memory) in a
 * separate process so leaks and native crashes can't take down the extension
 * host. The model stays loaded across sessions, avoiding the 2.5s reload
 * penalty.
 *
 * Uses child_process.fork() IPC (not worker_threads) for true process-level
 * isolation — a native segfault in ONNX kills only this process, not the
 * extension host. The main thread auto-restarts on crash.
 *
 * Supports configurable batch inference (argv batchSize, default 2).
 * If the process crashes during batch inference, the main thread restarts
 * with batchSize=1 (sequential fallback).
 *
 * Owns: model lifecycle, text-to-embedding inference.
 * Does not: persist embeddings, quantize vectors, touch SQLite or ~/.crispy/.
 *
 * @module recall/embed-worker
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL_ID = 'Xenova/nomic-embed-text-v1';

// Batch size passed via IPC init message or defaults to 2
let batchSize = 2;

// ---------------------------------------------------------------------------
// Model State
// ---------------------------------------------------------------------------

let embedder: any = null;
let loading: Promise<any> | null = null;

async function getEmbedder(): Promise<any> {
  if (embedder) return embedder;

  if (!loading) {
    loading = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');

        if (env.backends.onnx.wasm) {
          env.backends.onnx.wasm.proxy = false;
        }

        const model = await pipeline('feature-extraction', MODEL_ID);
        embedder = model;
        return model;
      } catch (err) {
        loading = null;
        throw err;
      }
    })();
  }

  embedder = await loading;
  return embedder;
}

async function disposeModel(): Promise<void> {
  if (embedder) {
    if (typeof embedder.dispose === 'function') await embedder.dispose();
    embedder = null;
    loading = null;
  }
}

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

/**
 * Embed a sub-batch of texts. When batchSize > 1, passes the array to the
 * model for true batch inference (attention matrices ∝ batch_size × seq_len²).
 * Falls back to sequential when batchSize === 1.
 */
async function embedSubBatch(model: any, texts: string[]): Promise<number[][]> {
  if (texts.length === 1 || batchSize <= 1) {
    // Sequential: one tensor alive at a time
    const vectors: number[][] = [];
    for (const text of texts) {
      const result = await model(text, { pooling: 'mean', normalize: true });
      const vec = Array.from(result.data as Float32Array);
      if (typeof result.dispose === 'function') result.dispose();
      vectors.push(vec);
    }
    return vectors;
  }

  // True batch inference
  const result = await model(texts, { pooling: 'mean', normalize: true });
  const data = result.data as Float32Array;
  const dim = data.length / texts.length;
  const vectors: number[][] = [];
  for (let j = 0; j < texts.length; j++) {
    vectors.push(Array.from(data.slice(j * dim, (j + 1) * dim)));
  }
  if (typeof result.dispose === 'function') result.dispose();
  return vectors;
}

// ---------------------------------------------------------------------------
// IPC Message Handler
// ---------------------------------------------------------------------------

function send(msg: any): void {
  if (process.send) process.send(msg);
}

process.on('message', async (msg: any) => {
  switch (msg.type) {
    case 'init': {
      batchSize = msg.batchSize ?? 2;
      send({ type: 'ready' });
      break;
    }

    case 'embed': {
      try {
        const model = await getEmbedder();
        const texts: string[] = msg.texts;
        const allVectors: number[][] = [];

        for (let i = 0; i < texts.length; i += Math.max(1, batchSize)) {
          const end = Math.min(i + batchSize, texts.length);
          const batch = texts.slice(i, end);
          const vectors = await embedSubBatch(model, batch);
          allVectors.push(...vectors);

          send({
            type: 'progress',
            id: msg.id,
            done: Math.min(i + batch.length, texts.length),
            total: texts.length,
          });
        }

        send({ type: 'result', id: msg.id, vectors: allVectors });
      } catch (err) {
        send({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'embedOne': {
      try {
        const model = await getEmbedder();
        const result = await model(msg.text, { pooling: 'mean', normalize: true });
        const vec = Array.from(result.data as Float32Array);
        if (typeof result.dispose === 'function') result.dispose();

        send({ type: 'resultOne', id: msg.id, vector: vec });
      } catch (err) {
        send({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'dispose': {
      await disposeModel();
      break;
    }

    case 'shutdown': {
      await disposeModel();
      process.exit(0);
    }
  }
});

// Signal readiness to parent
send({ type: 'ready' });
