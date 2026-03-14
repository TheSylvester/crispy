/**
 * Embedder — llama.cpp-based embedding pipeline
 *
 * Generates dense vector embeddings using llama.cpp's llama-embedding binary
 * with a nomic-embed-text-v1.5 GGUF model. Each embedBatch() call spawns a
 * single fresh process via child_process.execFile() with batch separator —
 * no persistent state, no memory leak.
 *
 * Binary and model are auto-downloaded on first use to ~/.crispy/bin/ and
 * ~/.crispy/models/ respectively. No manual setup required.
 *
 * Owns: binary + model download, text-to-embedding conversion.
 * Does not: persist embeddings, manage chunks, touch ~/.crispy/ (except bin/ and models/).
 *
 * @module recall/embedder
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync, createWriteStream, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir, platform, arch } from 'node:os';
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

// --- Binary download config ---

/** Last llama.cpp release that includes llama-embedding in prebuilt archives. */
const LLAMA_RELEASE_TAG = 'b5300';

const BIN_DIR = join(homedir(), '.crispy', 'bin');
const BIN_NAME = platform() === 'win32' ? 'llama-embedding.exe' : 'llama-embedding';

/** Map (platform, arch) → release asset filename. All assets are .zip. */
function getBinaryAssetName(): string {
  const p = platform();
  const a = arch();
  if (p === 'linux' && a === 'x64') return `llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-x64.zip`;
  if (p === 'linux' && a === 'arm64') return `llama-${LLAMA_RELEASE_TAG}-bin-ubuntu-arm64.zip`;
  if (p === 'darwin' && a === 'arm64') return `llama-${LLAMA_RELEASE_TAG}-bin-macos-arm64.zip`;
  if (p === 'darwin' && a === 'x64') return `llama-${LLAMA_RELEASE_TAG}-bin-macos-x64.zip`;
  if (p === 'win32' && a === 'x64') return `llama-${LLAMA_RELEASE_TAG}-bin-win-cpu-x64.zip`;
  throw new Error(`Unsupported platform for llama-embedding: ${p}/${a}`);
}

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

let binaryPath: string | null = null;

/** Shared promise for in-flight model download — prevents concurrent downloads. */
let downloadPromise: Promise<string> | null = null;

/** Shared promise for in-flight binary download. */
let binaryDownloadPromise: Promise<string> | null = null;

/**
 * Override the llama-embedding binary path. Optional — if not called,
 * ensureBinary() auto-downloads on first embedBatch() call.
 */
export function initEmbedder(binPath: string): void {
  binaryPath = binPath;
}

// ---------------------------------------------------------------------------
// Binary Management — auto-download llama-embedding
// ---------------------------------------------------------------------------

/** Returns the expected binary path. */
export function getBinaryPath(): string {
  return join(BIN_DIR, BIN_NAME);
}

/**
 * Ensure the llama-embedding binary exists on disk. Downloads from the
 * llama.cpp GitHub release if missing. Concurrent callers share the same
 * download promise.
 */
export async function ensureBinary(): Promise<string> {
  const binPath = getBinaryPath();

  if (existsSync(binPath)) {
    // Already downloaded — use it
    binaryPath = binPath;
    return binPath;
  }

  if (binaryDownloadPromise) return binaryDownloadPromise;

  binaryDownloadPromise = performBinaryDownload(binPath);
  try {
    const result = await binaryDownloadPromise;
    binaryPath = result;
    return result;
  } finally {
    binaryDownloadPromise = null;
  }
}

async function performBinaryDownload(binPath: string): Promise<string> {
  const assetName = getBinaryAssetName();
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/${assetName}`;

  mkdirSync(BIN_DIR, { recursive: true });

  const archivePath = join(BIN_DIR, assetName);
  const tmpPath = archivePath + '.tmp';

  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: `Downloading llama-embedding binary: ${assetName}`,
    data: { url, dest: binPath },
  });

  try {
    // Clean up stale .tmp
    if (existsSync(tmpPath)) unlinkSync(tmpPath);

    // Download archive
    await downloadFile(url, tmpPath);
    renameSync(tmpPath, archivePath);

    // Extract binary + required shared libraries from the zip.
    // -j junk paths (flatten), -o overwrite.
    const extractTargets = [
      `build/bin/${BIN_NAME}`,
      'build/bin/libllama*',
      'build/bin/libggml*',
    ];
    await execFileAsync('unzip', [
      '-o', '-j', archivePath,
      ...extractTargets,
      '-d', BIN_DIR,
    ]);

    // Clean up archive
    if (existsSync(archivePath)) {
      try { unlinkSync(archivePath); } catch { /* ignore */ }
    }

    // Ensure executable
    if (platform() !== 'win32') {
      chmodSync(binPath, 0o755);
    }

    pushRosieLog({
      source: 'recall-catchup',
      level: 'info',
      summary: 'llama-embedding binary download complete',
    });

    return binPath;
  } catch (err) {
    // Clean up on failure
    for (const p of [tmpPath, archivePath]) {
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
    throw err;
  }
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

    await downloadFile(MODEL_URL, tmpPath);
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
// Shared download helper
// ---------------------------------------------------------------------------

/** Download a URL to a local file, following one redirect (GitHub/HuggingFace pattern). */
async function downloadFile(url: string, destPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    import('node:https').then(({ default: https }) => {
      const file = createWriteStream(destPath);
      const pipeResponse = (response: import('node:http').IncomingMessage) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      };

      https.get(url, { headers: { 'User-Agent': 'crispy' } }, (response) => {
        // Follow redirects (GitHub uses 302, HuggingFace uses 302)
        if (response.statusCode === 301 || response.statusCode === 302) {
          const location = response.headers.location;
          if (!location) { reject(new Error('Redirect without location')); return; }
          https.get(location, { headers: { 'User-Agent': 'crispy' } }, pipeResponse).on('error', reject);
          return;
        }
        pipeResponse(response);
      }).on('error', reject);
    }).catch(reject);
  });
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

  // Lazy-resolve binary: download on first use if not already present
  if (!binaryPath) {
    await ensureBinary();
  }
  if (!binaryPath) throw new Error('llama-embedding binary not available');

  const modelPath = await ensureModel();
  // Strip the batch separator from input texts so it can't collide with the
  // delimiter llama-embedding uses to split multiple texts.
  const sanitized = texts.map(t => t.replaceAll(BATCH_SEPARATOR, ' '));
  const joined = sanitized.join(BATCH_SEPARATOR);
  const useFile = Buffer.byteLength(joined, 'utf-8') > MAX_ARG_BYTES;

  let tmpFile: string | null = null;
  try {
    const args = [
      '-m', modelPath,
      '--embd-output-format', 'array',
      '-c', '8192',
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

    // Shared libs (libllama.so, libggml*.so/dylib) live alongside the binary
    const libDir = join(binaryPath, '..');
    const envKey = platform() === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, [envKey]: libDir },
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
