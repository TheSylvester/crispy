/**
 * Embedder — llama.cpp-based embedding pipeline
 *
 * Generates dense vector embeddings using llama.cpp with a nomic-embed-text-v1.5
 * GGUF model. Supports two execution modes:
 *
 * - **One-shot** (≤5 texts, no server running): spawns a fresh llama-embedding
 *   process per call. Simple, no persistent state.
 * - **Server** (>5 texts, or server already running): starts a persistent
 *   llama-server that keeps the model loaded in RAM, accepting requests via
 *   HTTP over a Unix domain socket. Eliminates ~3-5s model load per batch.
 *
 * The server auto-starts on large batches, idles for 30s after the last
 * request, then shuts down. Callers see only embedBatch() — mode selection
 * is an internal implementation detail.
 *
 * Binary and model are auto-downloaded on first use to ~/.crispy/bin/ and
 * ~/.crispy/models/ respectively. No manual setup required.
 *
 * Owns: binary + model download, text-to-embedding conversion, server lifecycle.
 * Does not: persist embeddings, manage chunks, touch ~/.crispy/ (except bin/, models/, run/).
 *
 * @module recall/embedder
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync, mkdirSync, statSync, createWriteStream, renameSync,
  unlinkSync, chmodSync, readFileSync, writeFileSync, readdirSync,
} from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { request } from 'node:http';
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
const SERVER_BIN_NAME = platform() === 'win32' ? 'llama-server.exe' : 'llama-server';

// --- Server config ---

const RUN_DIR = join(homedir(), '.crispy', 'run');

/** Server mode requires Unix domain sockets — not available on native Windows. */
const SERVER_SUPPORTED = platform() !== 'win32';

/** Batch size threshold: ≤ this uses one-shot (if no server running). */
const SERVER_THRESHOLD = 5;

/** Idle timeout: kill server after this many ms of no requests. */
const IDLE_TIMEOUT_MS = 30_000;

/** Health check polling interval during server startup. */
const HEALTH_POLL_INTERVAL_MS = 200;

/** Max time to wait for server to become healthy. */
const HEALTH_POLL_TIMEOUT_MS = 15_000;

/** HTTP request timeout — accounts for queued requests with --parallel 1. */
const HTTP_REQUEST_TIMEOUT_MS = 120_000;

/** Max time to wait for SIGTERM before sending SIGKILL. */
const SERVER_KILL_TIMEOUT_MS = 5_000;

/** After server failure, suppress server attempts for this duration. */
const SERVER_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

let binaryPath: string | null = null;

/** Shared promise for in-flight model download — prevents concurrent downloads. */
let downloadPromise: Promise<string> | null = null;

/** Shared promise for in-flight binary download. */
let binaryDownloadPromise: Promise<string> | null = null;

// --- Server state ---

let serverProcess: ChildProcess | null = null;
let activeSocketPath: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let serverStartPromise: Promise<string> | null = null;
let serverCooldownUntil = 0;
/** Shared promise for concurrent kill→restart so only one caller does it. */
let serverRetryPromise: Promise<string> | null = null;
/** Number of active in-flight server requests — suppresses idle timer while > 0. */
let activeServerRequests = 0;

/**
 * Override the llama-embedding binary path. Optional — if not called,
 * ensureBinary() auto-downloads on first embedBatch() call.
 */
export function initEmbedder(binPath: string): void {
  binaryPath = binPath;
}

// ---------------------------------------------------------------------------
// Binary Management — auto-download llama-embedding + llama-server
// ---------------------------------------------------------------------------

/** Returns the expected llama-embedding binary path. */
export function getBinaryPath(): string {
  return join(BIN_DIR, BIN_NAME);
}

/** Returns the expected llama-server binary path. */
function getServerBinaryPath(): string {
  return join(BIN_DIR, SERVER_BIN_NAME);
}

/** Detect NVIDIA GPU by checking if nvidia-smi exits successfully. */
async function hasNvidiaGpu(): Promise<boolean> {
  try {
    await execFileAsync('nvidia-smi', [], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Map (platform, arch, gpu) → release asset filename. All assets are .zip.
 *  CUDA builds are selected when an NVIDIA GPU is detected on Linux/Windows x64.
 *  macOS ARM64 includes Metal acceleration in the standard build. */
async function getBinaryAssetName(): Promise<string> {
  const p = platform();
  const a = arch();
  const tag = LLAMA_RELEASE_TAG;

  // Linux: no CUDA build available from llama.cpp releases. Vulkan build
  // exists but fails on WSL2 (ErrorOutOfDeviceMemory for KV cache allocation).
  // Use CPU build for now — GPU acceleration requires building from source.
  if (p === 'linux' && a === 'x64') return `llama-${tag}-bin-ubuntu-x64.zip`;

  if (p === 'linux' && a === 'arm64') return `llama-${tag}-bin-ubuntu-arm64.zip`;
  if (p === 'darwin' && a === 'arm64') return `llama-${tag}-bin-macos-arm64.zip`;
  if (p === 'darwin' && a === 'x64') return `llama-${tag}-bin-macos-x64.zip`;
  if (p === 'win32' && a === 'x64') {
    if (await hasNvidiaGpu()) return `llama-${tag}-bin-win-cuda-cu12.4-x64.zip`;
    return `llama-${tag}-bin-win-cpu-x64.zip`;
  }
  throw new Error(`Unsupported platform for llama-embedding: ${p}/${a}`);
}

/**
 * Ensure both llama-embedding and llama-server binaries exist on disk.
 * Downloads from the llama.cpp GitHub release if either is missing.
 * Concurrent callers share the same download promise.
 */
export async function ensureBinary(): Promise<string> {
  const binPath = getBinaryPath();
  const serverBinPath = getServerBinaryPath();

  // Both must exist (server only required on Unix-like platforms)
  const embeddingExists = existsSync(binPath);
  const serverNeeded = SERVER_SUPPORTED && !existsSync(serverBinPath);

  if (embeddingExists && !serverNeeded) {
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
  const assetName = await getBinaryAssetName();
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/${assetName}`;

  mkdirSync(BIN_DIR, { recursive: true });

  const archivePath = join(BIN_DIR, assetName);
  const tmpPath = archivePath + '.tmp';

  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: `Downloading llama binaries: ${assetName}${assetName.includes('cuda') || assetName.includes('vulkan') ? ' (GPU accelerated)' : ''}`,
    data: { url, dest: binPath },
  });

  try {
    // Clean up stale .tmp
    if (existsSync(tmpPath)) unlinkSync(tmpPath);

    // Download archive
    await downloadFile(url, tmpPath);
    renameSync(tmpPath, archivePath);

    // Extract both binaries + required shared libraries from the zip.
    // -j junk paths (flatten), -o overwrite.
    // CUDA builds also include libcublas*, libcudart*; Vulkan includes libvulkan*.
    const extractTargets = [
      `build/bin/${BIN_NAME}`,
      `build/bin/${SERVER_BIN_NAME}`,
      'build/bin/libllama*',
      'build/bin/libggml*',
    ];
    if (assetName.includes('cuda')) {
      extractTargets.push('build/bin/libcublas*', 'build/bin/libcudart*');
    }
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
      const serverBin = getServerBinaryPath();
      if (existsSync(serverBin)) {
        chmodSync(serverBin, 0o755);
      }
    }

    pushRosieLog({
      source: 'recall-catchup',
      level: 'info',
      summary: 'llama binaries download complete',
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
// Server Lifecycle
// ---------------------------------------------------------------------------

/** Check if a process with the given PID is still alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Socket and PID file paths — constant per process, cached at module load. */
const SOCKET_PATH = join(RUN_DIR, `llama-embed-${process.pid}.sock`);
const PID_FILE_PATH = join(RUN_DIR, `llama-embed-${process.pid}.pid`);

/** Write PID file with server metadata. */
function writePidFile(pid: number, socketPath: string): void {
  writeFileSync(PID_FILE_PATH, JSON.stringify({
    pid,
    socketPath,
    startedAt: new Date().toISOString(),
    ownerPid: process.pid,
  }));
}

/** Remove PID file and socket. */
function cleanupPidAndSocket(): void {
  for (const f of [PID_FILE_PATH, SOCKET_PATH]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}

/** Clean up stale PID files from dead processes. */
function cleanupStalePidFiles(): void {
  if (!existsSync(RUN_DIR)) return;
  try {
    const files = readdirSync(RUN_DIR).filter(f => f.startsWith('llama-embed-') && f.endsWith('.pid'));
    for (const f of files) {
      const pidFile = join(RUN_DIR, f);
      try {
        const data = JSON.parse(readFileSync(pidFile, 'utf-8'));
        // Check if the OWNER process is alive — if it died, the server is orphaned
        const ownerPid = data.ownerPid ?? data.pid;
        if (!isProcessAlive(ownerPid)) {
          // Kill orphaned server if still alive
          if (data.pid && isProcessAlive(data.pid)) {
            try { process.kill(data.pid, 'SIGTERM'); } catch { /* ignore */ }
          }
          try { unlinkSync(pidFile); } catch { /* ignore */ }
          if (data.socketPath) {
            try { unlinkSync(data.socketPath); } catch { /* ignore */ }
          }
        }
      } catch {
        // Corrupt PID file — remove it
        try { unlinkSync(pidFile); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/** Perform HTTP health check against the server. */
function healthCheck(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { socketPath, path: '/health', method: 'GET', timeout: 2000 },
      (res) => { resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Poll /health until the server is ready, bailing early if the process exits. */
async function waitForHealth(socketPath: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited during startup (code ${child.exitCode})`);
    }
    if (await healthCheck(socketPath)) return;
    await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`llama-server failed to become healthy within ${HEALTH_POLL_TIMEOUT_MS}ms`);
}

/** Start the llama-server process and wait for it to become healthy. */
async function startServer(): Promise<string> {
  const modelPath = await ensureModel();
  const serverBin = getServerBinaryPath();
  if (!existsSync(serverBin)) {
    throw new Error('llama-server binary not available');
  }

  mkdirSync(RUN_DIR, { recursive: true });

  // Clean up any stale socket from a previous crash
  const socket = SOCKET_PATH;
  if (existsSync(socket)) {
    try { unlinkSync(socket); } catch { /* ignore */ }
  }

  // Shared libs live alongside the binary
  const libDir = join(serverBin, '..');
  const envKey = platform() === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';

  const child = spawn(serverBin, [
    '-m', modelPath,
    '--embeddings',
    '--host', socket,
    '-c', '8192',
    '-b', '8192',        // physical batch size — must match -c or large inputs get HTTP 500
    '-ub', '8192',       // micro-batch (ubatch) — also defaults to 512, must be raised
    '--parallel', '1',
    '--log-disable',
  ], {
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, [envKey]: libDir },
  });

  // Guard: only clear state if this child is still the active server —
  // prevents a dying old child from clobbering a replacement server's state.
  const handleChildGone = () => {
    if (serverProcess === child) {
      serverProcess = null;
      activeSocketPath = null;
      clearIdleTimer();
      cleanupPidAndSocket();
    }
  };

  child.on('exit', handleChildGone);
  child.on('error', (err) => {
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: `llama-server process error: ${err.message}`,
    });
    handleChildGone();
  });

  serverProcess = child;
  activeSocketPath = socket;

  // Write PID file for stale cleanup
  if (child.pid) {
    writePidFile(child.pid, socket);
  }

  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: `Starting llama-server (PID ${child.pid}, socket ${socket})`,
  });

  // Wait for /health to return 200 — bail early if the process exits
  await waitForHealth(socket, child);

  pushRosieLog({
    source: 'recall-catchup',
    level: 'info',
    summary: 'llama-server ready',
  });

  return socket;
}

/** Kill the server process, clean up socket + PID file. */
async function killServer(): Promise<void> {
  clearIdleTimer();
  const child = serverProcess;
  serverProcess = null;
  activeSocketPath = null;

  if (!child || child.exitCode !== null) {
    cleanupPidAndSocket();
    return;
  }

  return new Promise<void>((resolve) => {
    const forceKillTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      cleanupPidAndSocket();
      resolve();
    }, SERVER_KILL_TIMEOUT_MS);
    forceKillTimer.unref(); // Don't block process exit waiting for SIGKILL

    child.once('exit', () => {
      clearTimeout(forceKillTimer);
      cleanupPidAndSocket();
      resolve();
    });

    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  });
}

/** Reset the idle timer — only starts countdown when no requests are in-flight. */
function resetIdleTimer(): void {
  clearIdleTimer();
  if (activeServerRequests > 0) return; // Don't start idle countdown while requests are active
  idleTimer = setTimeout(() => {
    if (activeServerRequests > 0) return; // Double-check before killing
    pushRosieLog({
      source: 'recall-catchup',
      level: 'info',
      summary: 'llama-server idle timeout — shutting down',
    });
    killServer().catch(() => {});
  }, IDLE_TIMEOUT_MS);
  // Don't block process exit while waiting for idle timeout
  idleTimer.unref();
}

/** Clear the idle timer. */
function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/**
 * Ensure the server is running and return its socket path.
 * Mutex via serverStartPromise prevents concurrent startup races from
 * Promise.all in catchup-manager.
 */
async function ensureServer(): Promise<string> {
  // Already running — clear idle timer since a request is coming
  if (activeSocketPath && serverProcess) {
    clearIdleTimer();
    return activeSocketPath;
  }

  // Another call is already starting the server — wait for it
  if (serverStartPromise) return serverStartPromise;

  serverStartPromise = startServer();
  try {
    return await serverStartPromise;
  } finally {
    serverStartPromise = null;
  }
}

/**
 * Kill the current server and start a fresh one. Mutex via serverRetryPromise
 * ensures concurrent callers (from Promise.all in catchup-manager) share a
 * single kill→restart cycle instead of stomping on each other.
 */
async function retryServer(): Promise<string> {
  if (serverRetryPromise) return serverRetryPromise;
  serverRetryPromise = (async () => {
    await killServer();
    return ensureServer();
  })();
  try {
    return await serverRetryPromise;
  } finally {
    serverRetryPromise = null;
  }
}

// ---------------------------------------------------------------------------
// HTTP Embedding (server path)
// ---------------------------------------------------------------------------

/** POST JSON to the server and return status + body. */
function httpPost(
  socketPath: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * Embed texts via the running server's /v1/embeddings endpoint.
 * Validates response dimensions and preserves ordering via index field.
 */
async function embedViaHttp(socketPath: string, texts: string[]): Promise<Float32Array[]> {
  const response = await httpPost(
    socketPath,
    '/v1/embeddings',
    { input: texts, model: 'ignored' },
    HTTP_REQUEST_TIMEOUT_MS,
  );

  if (response.status !== 200) {
    throw new Error(`llama-server returned HTTP ${response.status}: ${response.body.slice(0, 200)}`);
  }

  let parsed: { data: Array<{ embedding: number[]; index: number }> };
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error(`Failed to parse llama-server response: ${response.body.slice(0, 200)}`);
  }

  if (!parsed.data || parsed.data.length !== texts.length) {
    throw new Error(`Expected ${texts.length} embeddings, got ${parsed.data?.length ?? 'none'}`);
  }

  // Sort by index to preserve input ordering
  const sorted = [...parsed.data].sort((a, b) => a.index - b.index);

  return sorted.map((item, i) => {
    if (!Array.isArray(item.embedding) || item.embedding.length !== EXPECTED_DIMS) {
      throw new Error(`Embedding ${i}: expected ${EXPECTED_DIMS} dims, got ${Array.isArray(item.embedding) ? item.embedding.length : 'non-array'}`);
    }
    return new Float32Array(item.embedding);
  });
}

// ---------------------------------------------------------------------------
// Process Embedding (one-shot path)
// ---------------------------------------------------------------------------

/**
 * Embed texts by spawning a fresh llama-embedding process.
 * Extracted from original embedBatch() internals — identical behavior.
 */
async function embedViaProcess(texts: string[], modelPath: string): Promise<Float32Array[]> {
  if (!binaryPath) throw new Error('llama-embedding binary not available');

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
 * Embed multiple texts. Automatically selects between one-shot process
 * (small batches, no server running) and persistent server (large batches
 * or server already active).
 *
 * The server starts on demand for batches > 5 texts and idles for 30s.
 * If the server fails, falls back to one-shot with a 60s cooldown before
 * retrying the server.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  // Lazy-resolve binary: download on first use if not already present
  if (!binaryPath) {
    await ensureBinary();
  }
  if (!binaryPath) throw new Error('llama-embedding binary not available');

  const modelPath = await ensureModel();

  // Decide: one-shot vs server
  // Use server if: platform supports it AND (large batch OR server already running)
  // AND not in cooldown from a recent server failure
  const useServer = SERVER_SUPPORTED
    && (texts.length > SERVER_THRESHOLD || serverProcess !== null)
    && Date.now() >= serverCooldownUntil;

  if (!useServer) {
    return embedViaProcess(texts, modelPath);
  }

  // Server path: try server, retry once (with mutex), then fall back to one-shot
  try {
    const socketPath = await ensureServer();
    activeServerRequests++;
    try {
      const result = await embedViaHttp(socketPath, texts);
      return result;
    } finally {
      activeServerRequests--;
      resetIdleTimer();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushRosieLog({
      source: 'recall-catchup',
      level: 'warn',
      summary: `Server embedding failed, attempting restart: ${msg}`,
    });

    // Retry once — retryServer() has a mutex so concurrent callers share
    // a single kill→restart cycle instead of stomping on each other.
    try {
      const socketPath = await retryServer();
      activeServerRequests++;
      try {
        const result = await embedViaHttp(socketPath, texts);
        return result;
      } finally {
        activeServerRequests--;
        resetIdleTimer();
      }
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      pushRosieLog({
        source: 'recall-catchup',
        level: 'warn',
        summary: `Server restart failed, falling back to one-shot: ${retryMsg}`,
      });
      serverCooldownUntil = Date.now() + SERVER_COOLDOWN_MS;
      return embedViaProcess(texts, modelPath);
    }
  }
}

/**
 * Dispose the embedder — kill the server if running, clean up socket + PID file.
 * Call on extension deactivation or process shutdown.
 */
export async function disposeEmbedder(): Promise<void> {
  await killServer();
}

// ---------------------------------------------------------------------------
// Module-level initialization
// ---------------------------------------------------------------------------

// Clean up stale PID files from dead processes on module load
if (SERVER_SUPPORTED) {
  cleanupStalePidFiles();
}
