/**
 * Embedder — Lazy-loading Nomic Embed Code embedding pipeline
 *
 * Generates dense vector embeddings for text using Nomic Embed Code via
 * @huggingface/transformers. The model downloads on first use (~270 MB)
 * and is cached by HuggingFace's default cache mechanism.
 *
 * Routes inference through a child process when initialized via
 * initEmbedWorker(). The child process provides true process-level isolation
 * — a native ONNX crash (segfault) kills only the child, not the extension
 * host. The model stays loaded across sessions, avoiding the 2.5s reload
 * penalty per session.
 *
 * Falls back to in-process inference if initEmbedWorker() was never called
 * (e.g. test scripts with --no-worker). All callers use the same public
 * API: embed(), embedBatch(), disposeEmbedder().
 *
 * Owns: model lifecycle (via child process or in-process), text-to-embedding conversion.
 * Does not: persist embeddings, manage chunks, touch ~/.crispy/.
 *
 * @module recall/embedder
 */

import { fork, type ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL_ID = 'Xenova/nomic-embed-text-v1';

// ---------------------------------------------------------------------------
// Child Process State
// ---------------------------------------------------------------------------

/** Path to the worker script (set by initEmbedWorker). */
let workerPath: string | null = null;

/** Whether to spawn the worker via tsx (dev mode) or node (bundled). */
let useTsx = false;

/** Live child process — spawned lazily on first embed call. */
let child: ChildProcess | null = null;

/** Auto-incrementing request ID for correlating responses. */
let nextRequestId = 0;

/** Pending promises keyed by request ID. */
const pending = new Map<number, {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}>();

/** Current batch size for worker inference. Drops to 1 on crash. */
let batchSize = 2;

/** Whether the worker has been intentionally shut down (prevents auto-respawn). */
let shutdownRequested = false;

/** Per-request timeout (ms). Generous — covers model load (~4s) + longest message (~800ms). */
const REQUEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// In-process Fallback State
// ---------------------------------------------------------------------------

let inProcessEmbedder: any = null;
let inProcessLoading: Promise<any> | null = null;

// ---------------------------------------------------------------------------
// Child Process Lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize the child-process-based embedding pipeline.
 *
 * Call once at startup (extension activate or dev-server boot). Subsequent
 * embed() / embedBatch() calls route through the child process automatically.
 *
 * @param scriptPath  Absolute path to the embed-worker script.
 * @param tsx         If true, spawn via tsx (dev mode with TypeScript source).
 */
export function initEmbedWorker(scriptPath: string, tsx?: boolean): void {
  workerPath = scriptPath;
  useTsx = tsx ?? false;
  shutdownRequested = false;
}

/**
 * Terminate the child process. Call on extension deactivation.
 * Safe to call multiple times or when no child is running.
 */
export function shutdownEmbedWorker(): void {
  shutdownRequested = true;
  if (child) {
    child.send({ type: 'shutdown' });
    child = null;
  }
  rejectAllPending('Worker shut down');
}

function rejectAllPending(reason: string): void {
  for (const [id, p] of pending) {
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

/**
 * Send a message to the child and return a promise that rejects on timeout.
 * Cleans up the pending entry and kills the child on timeout so it doesn't
 * linger in a deadlocked state.
 */
function sendWithTimeout<T>(cp: ChildProcess, msg: any): Promise<T> {
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Embed request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      // Kill the hung child — next embed call will auto-spawn a fresh one
      if (child === cp) {
        console.error('[embedder] Killing hung child process');
        cp.kill();
        child = null;
      }
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, {
      resolve: (value: T) => { clearTimeout(timer); resolve(value); },
      reject: (reason: any) => { clearTimeout(timer); reject(reason); },
    });

    cp.send({ ...msg, id });
  });
}

function spawnChild(): ChildProcess {
  // For dev mode (tsx), fork with tsx as the execPath
  // For bundled mode, fork directly with node
  const execArgv = useTsx ? ['--import', 'tsx'] : [];

  const cp = fork(workerPath!, [], {
    execArgv,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // Prevent child from inheriting CLAUDECODE which blocks nested Claude sessions
    env: { ...process.env, CLAUDECODE: undefined },
  });

  cp.on('message', (msg: any) => {
    switch (msg.type) {
      case 'ready':
        // Child is up — nothing to do, first embed call triggers model load.
        break;

      case 'result': {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          // Vectors arrive as number[][] over IPC — reconstruct Float32Arrays
          const vectors = (msg.vectors as number[][]).map(
            (arr: number[]) => new Float32Array(arr),
          );
          p.resolve(vectors);
        }
        break;
      }

      case 'resultOne': {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve(new Float32Array(msg.vector as number[]));
        }
        break;
      }

      case 'error': {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.reject(new Error(msg.message));
        }
        break;
      }

      case 'progress':
        // Could be surfaced to callers in the future; currently ignored.
        break;
    }
  });

  cp.on('error', (err) => {
    console.error('[embedder] Child process error:', err.message);
  });

  cp.on('exit', (code, signal) => {
    // Child exited — clean up
    child = null;
    if (code !== 0 && !shutdownRequested) {
      console.error(`[embedder] Child process exited with code ${code}, signal ${signal}`);

      // Auto-fallback: reduce batch size on crash
      if (batchSize > 1) {
        console.error(`[embedder] Reducing batch size from ${batchSize} to 1`);
        batchSize = 1;
      }

      // Reject all pending requests — callers will retry (triggering respawn)
      rejectAllPending(`Child process exited with code ${code}`);
    }
  });

  // Send init message with current batch size
  cp.send({ type: 'init', batchSize });

  return cp;
}

function getChild(): ChildProcess {
  if (!child) {
    child = spawnChild();
  }
  return child;
}

// ---------------------------------------------------------------------------
// In-process Fallback
// ---------------------------------------------------------------------------

async function getInProcessEmbedder(): Promise<any> {
  if (inProcessEmbedder) return inProcessEmbedder;

  if (!inProcessLoading) {
    inProcessLoading = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');

        if (env.backends.onnx.wasm) {
          env.backends.onnx.wasm.proxy = false;
        }

        const model = await pipeline('feature-extraction', MODEL_ID);
        inProcessEmbedder = model;
        return model;
      } catch (err) {
        inProcessLoading = null;
        throw err;
      }
    })();
  }

  inProcessEmbedder = await inProcessLoading;
  return inProcessEmbedder;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed a single text string into a normalized 768-dimensional vector.
 *
 * Routes through the child process if initialized, otherwise falls back
 * to in-process inference.
 *
 * @param text  The text to embed (code snippet, markdown chunk, query, etc.)
 * @returns     Normalized float32 embedding vector (768 dimensions).
 */
export async function embed(text: string): Promise<Float32Array> {
  // Child process path
  if (workerPath && !shutdownRequested) {
    return sendWithTimeout<Float32Array>(getChild(), { type: 'embedOne', text });
  }

  // In-process fallback
  const model = await getInProcessEmbedder();
  const result = await model(text, { pooling: 'mean', normalize: true });
  const vec = (result.data as Float32Array).slice();
  if (typeof result.dispose === 'function') result.dispose();
  return vec;
}

/**
 * Embed multiple texts, returning one vector per text.
 *
 * Routes through the child process if initialized (supports batch inference),
 * otherwise falls back to sequential in-process inference.
 *
 * @param texts  Array of text strings to embed.
 * @returns      Array of normalized float32 embedding vectors (768-dim each).
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  // Child process path
  if (workerPath && !shutdownRequested) {
    return sendWithTimeout<Float32Array[]>(getChild(), { type: 'embed', texts });
  }

  // In-process fallback
  const model = await getInProcessEmbedder();
  const results: Float32Array[] = [];
  for (const text of texts) {
    const result = await model(text, { pooling: 'mean', normalize: true });
    results.push((result.data as Float32Array).slice());
    if (typeof result.dispose === 'function') result.dispose();
  }
  return results;
}

/**
 * Dispose the embedding model to release native memory.
 *
 * In child process mode: sends a dispose message (frees ONNX memory in child,
 * process stays alive for next activation). In-process: disposes the cached
 * pipeline directly.
 *
 * Next embed call will re-load the model (~2-10s).
 */
export async function disposeEmbedder(): Promise<void> {
  // Child process path
  if (child) {
    child.send({ type: 'dispose' });
    return;
  }

  // In-process fallback
  if (inProcessEmbedder) {
    if (typeof inProcessEmbedder.dispose === 'function') await inProcessEmbedder.dispose();
    inProcessEmbedder = null;
    inProcessLoading = null;
  }
}
