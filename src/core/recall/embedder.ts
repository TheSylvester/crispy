/**
 * Embedder — llama.cpp-based embedding pipeline
 *
 * Generates dense vector embeddings using llama.cpp's llama-embedding binary
 * with a nomic-embed-text-v1.5 GGUF model. Each embedBatch() call spawns a
 * single fresh process via child_process.execFile() with batch separator —
 * no persistent state, no memory leak.
 *
 * Owns: binary path resolution, model download, text-to-embedding conversion.
 * Does not: persist embeddings, manage chunks, touch ~/.crispy/ (except models/).
 *
 * @module recall/embedder
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync, createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { promisify } from 'node:util';
import { pushRosieLog } from '../rosie/debug-log.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL_FILENAME = 'nomic-embed-text-v1.5.Q8_0.gguf';
const MODEL_URL = 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf';
const MODEL_DIR = join(homedir(), '.crispy', 'models');
const EXPECTED_DIMS = 768;
const BATCH_SEPARATOR = '<#sep#>';

/** Max bytes for -p argument before switching to -f file input. */
const MAX_ARG_BYTES = 100_000;

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

let binaryPath: string | null = null;

/** Shared promise for in-flight model download — prevents concurrent downloads. */
let downloadPromise: Promise<string> | null = null;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Set the path to the llama-embedding binary. Call once at startup.
 */
export function initEmbedder(binPath: string): void {
  binaryPath = binPath;
}

// ---------------------------------------------------------------------------
// Model Management
// ---------------------------------------------------------------------------

/** Returns the expected model file path. */
export function getModelPath(): string {
  return join(MODEL_DIR, MODEL_FILENAME);
}

/**
 * Ensure the GGUF model exists on disk. Downloads from HuggingFace if missing.
 * Uses atomic download (write to .tmp, then rename). Concurrent callers share
 * the same download promise — no polling, no duplicate downloads.
 */
export async function ensureModel(): Promise<string> {
  const modelPath = getModelPath();

  // Check if model already exists and is large enough to be valid
  if (existsSync(modelPath)) {
    const stat = statSync(modelPath);
    if (stat.size > 100_000_000) return modelPath;
  }

  // Share a single download promise across concurrent callers
  if (downloadPromise) return downloadPromise;

  downloadPromise = performModelDownload(modelPath);
  try {
    return await downloadPromise;
  } finally {
    downloadPromise = null;
  }
}

async function performModelDownload(modelPath: string): Promise<string> {
  const tmpPath = modelPath + '.tmp';
  try {
    mkdirSync(MODEL_DIR, { recursive: true });

    // Clean up stale .tmp from interrupted download
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }

    pushRosieLog({
      source: 'recall-catchup',
      level: 'info',
      summary: `Downloading embedding model: ${MODEL_FILENAME}`,
      data: { url: MODEL_URL, dest: modelPath },
    });

    // Download to temp file, then atomic rename
    await new Promise<void>((resolve, reject) => {
      // Dynamic import avoids bundler issues with node:https
      import('node:https').then(({ default: https }) => {
        const file = createWriteStream(tmpPath);
        const pipeResponse = (response: import('node:http').IncomingMessage) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', reject);
        };

        https.get(MODEL_URL, { headers: { 'User-Agent': 'crispy' } }, (response) => {
          // Follow redirects (HuggingFace uses 302)
          if (response.statusCode === 301 || response.statusCode === 302) {
            const location = response.headers.location;
            if (!location) { reject(new Error('Redirect without location')); return; }
            https.get(location, pipeResponse).on('error', reject);
            return;
          }
          pipeResponse(response);
        }).on('error', reject);
      }).catch(reject);
    });

    renameSync(tmpPath, modelPath);

    pushRosieLog({
      source: 'recall-catchup',
      level: 'info',
      summary: 'Embedding model download complete',
    });

    return modelPath;
  } catch (err) {
    // Clean up failed download
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed a single text string into a normalized 768-dimensional vector.
 */
export async function embed(text: string): Promise<Float32Array> {
  const [result] = await embedBatch([text]);
  return result;
}

/**
 * Embed multiple texts in a single llama-embedding invocation.
 *
 * Joins texts with the batch separator and spawns ONE process. For texts
 * containing the separator or exceeding OS arg limits, falls back to file
 * input via -f flag.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (!binaryPath) throw new Error('Embedder not initialized — call initEmbedder() first');

  const modelPath = await ensureModel();
  const joined = texts.join(BATCH_SEPARATOR);
  const useFile = Buffer.byteLength(joined, 'utf-8') > MAX_ARG_BYTES ||
                  texts.some(t => t.includes(BATCH_SEPARATOR));

  let tmpFile: string | null = null;
  try {
    const args = [
      '-m', modelPath,
      '--embd-output-format', 'array',
      '-c', '8192',
      '--log-disable',
    ];

    if (texts.length > 1) {
      args.push('--embd-separator', BATCH_SEPARATOR);
    }

    if (useFile) {
      tmpFile = join(tmpdir(), `crispy-embed-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      await writeFile(tmpFile, joined, 'utf-8');
      args.push('-f', tmpFile);
    } else {
      args.push('-p', joined);
    }

    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      maxBuffer: 1024 * 1024,
    });

    if (stderr) {
      pushRosieLog({
        source: 'recall-catchup',
        level: 'warn',
        summary: 'llama-embedding stderr',
        data: { stderr: stderr.slice(0, 500) },
      });
    }

    // Parse [[x1,...,xn],[x1,...,xn],...]
    const trimmed = stdout.trim();
    let parsed: number[][];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Failed to parse llama-embedding output: ${trimmed.slice(0, 200)}`);
    }

    if (!Array.isArray(parsed) || parsed.length !== texts.length) {
      throw new Error(`Expected ${texts.length} vectors, got ${Array.isArray(parsed) ? parsed.length : 'non-array'}`);
    }

    return parsed.map((vec, i) => {
      if (!Array.isArray(vec) || vec.length !== EXPECTED_DIMS) {
        throw new Error(`Vector ${i}: expected ${EXPECTED_DIMS} dims, got ${Array.isArray(vec) ? vec.length : 'non-array'}`);
      }
      return new Float32Array(vec);
    });
  } finally {
    if (tmpFile) {
      await unlink(tmpFile).catch(() => {});
    }
  }
}

/**
 * Dispose the embedder. No-op with one-shot process model — nothing to dispose.
 */
export async function disposeEmbedder(): Promise<void> {
  // No-op: each embedBatch() spawns a fresh process, no persistent state
}
