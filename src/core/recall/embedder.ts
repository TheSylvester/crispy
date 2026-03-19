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
  unlinkSync, chmodSync, readFileSync, writeFileSync, readdirSync, rmSync,
} from 'node:fs';
import { writeFile, unlink, cp, readdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir, platform, arch } from 'node:os';
import { promisify } from 'node:util';
import extract from 'extract-zip';
import { log } from '../log.js';
import { modelsDir, binDir, runDir } from '../paths.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL_FILENAME = 'nomic-embed-text-v1.5.Q8_0.gguf';
const MODEL_URL = 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf';
const EXPECTED_DIMS = 768;
const BATCH_SEPARATOR = '<#sep#>';

/** Max bytes for -p argument before switching to -f file input.
 *  Windows CreateProcess has a 32,767 char command line limit — always use
 *  file input there to avoid ENAMETOOLONG on large batches. */
const MAX_ARG_BYTES = platform() === 'win32' ? 0 : 100_000;

// --- Binary download config ---

/** Last llama.cpp release that includes llama-embedding in prebuilt archives. */
const LLAMA_RELEASE_TAG = 'b5300';

const BIN_NAME = platform() === 'win32' ? 'llama-embedding.exe' : 'llama-embedding';
const SERVER_BIN_NAME = platform() === 'win32' ? 'llama-server.exe' : 'llama-server';

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
// Embedding Mutex — serializes embed calls to prevent CPU contention
// ---------------------------------------------------------------------------

/** Queue of pending embedding requests waiting for the mutex. */
let embedQueue: Array<{
  resolve: (value: Float32Array[]) => void;
  reject: (reason: unknown) => void;
  fn: () => Promise<Float32Array[]>;
}> = [];
let embedRunning = false;

/** Run an embedding function under a process-level mutex. */
async function withEmbedMutex(fn: () => Promise<Float32Array[]>): Promise<Float32Array[]> {
  return new Promise<Float32Array[]>((resolve, reject) => {
    embedQueue.push({ resolve, reject, fn });
    drainEmbedQueue();
  });
}

async function drainEmbedQueue(): Promise<void> {
  if (embedRunning || embedQueue.length === 0) return;
  embedRunning = true;
  const item = embedQueue.shift()!;
  try {
    const result = await item.fn();
    item.resolve(result);
  } catch (err) {
    item.reject(err);
  } finally {
    embedRunning = false;
    drainEmbedQueue();
  }
}

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
  return join(binDir(), BIN_NAME);
}

/** Returns the expected llama-server binary path. */
function getServerBinaryPath(): string {
  return join(binDir(), SERVER_BIN_NAME);
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

/** Map (platform, arch, gpu) → ordered list of release asset filenames to try.
 *  Returns an array: first entry is preferred (e.g. CUDA), rest are fallbacks.
 *  CUDA builds are tried first when an NVIDIA GPU is detected on Windows x64,
 *  falling back to CPU if the CUDA binary fails (missing CUDA toolkit).
 *  macOS ARM64 includes Metal acceleration in the standard build. */
async function getBinaryAssetCandidates(): Promise<string[]> {
  const p = platform();
  const a = arch();
  const tag = LLAMA_RELEASE_TAG;

  // Linux: no CUDA build available from llama.cpp releases. Vulkan build
  // exists but fails on WSL2 (ErrorOutOfDeviceMemory for KV cache allocation).
  // Use CPU build for now — GPU acceleration requires building from source.
  if (p === 'linux' && a === 'x64') return [`llama-${tag}-bin-ubuntu-x64.zip`];

  if (p === 'linux' && a === 'arm64') return [`llama-${tag}-bin-ubuntu-arm64.zip`];
  if (p === 'darwin' && a === 'arm64') return [`llama-${tag}-bin-macos-arm64.zip`];
  if (p === 'darwin' && a === 'x64') return [`llama-${tag}-bin-macos-x64.zip`];
  if (p === 'win32' && a === 'x64') {
    if (await hasNvidiaGpu()) {
      // Try CUDA first, fall back to CPU if CUDA toolkit isn't installed
      return [
        `llama-${tag}-bin-win-cuda-cu12.4-x64.zip`,
        `llama-${tag}-bin-win-cpu-x64.zip`,
      ];
    }
    return [`llama-${tag}-bin-win-cpu-x64.zip`];
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

/** Files we actually need from the llama.cpp release archive. */
const WANTED_FILES = new Set([
  // Binaries
  BIN_NAME,               // llama-embedding / llama-embedding.exe
  SERVER_BIN_NAME,         // llama-server / llama-server.exe
  // Shared libraries (all platforms)
  'libllama.so', 'libllama.dylib', 'llama.dll',
  'libggml.so', 'libggml.dylib', 'ggml.dll',
]);

/** Patterns for shared libraries we need (DLLs, .so, .dylib). */
const WANTED_LIB_PATTERNS = [
  /^ggml.*\.(dll|so|dylib)$/,
  /^libggml.*\.(dll|so|dylib)$/,
  /^llama\.(dll|so|dylib)$/,
  /^libllama\.(dll|so|dylib)$/,
  /^libcurl.*\.(dll|so|dylib)$/,
  // CUDA runtime DLLs that may be bundled
  /^cublas.*\.dll$/,
  /^cudart.*\.dll$/,
  /^cublasLt.*\.dll$/,
];

/** Check if a filename is one we need to extract. */
function isWantedFile(name: string): boolean {
  if (WANTED_FILES.has(name)) return true;
  return WANTED_LIB_PATTERNS.some(p => p.test(name));
}

/**
 * Smoke-test the llama-embedding binary to verify it can load and run.
 * Only fails on spawn errors (missing DLLs, blocked by antivirus, wrong
 * architecture). A non-zero exit code (e.g. "no model specified") still
 * means the binary loaded successfully — that's a pass.
 */
async function validateBinary(binPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const libDir = join(binPath, '..');
    const env = { ...process.env };
    if (platform() === 'win32') {
      env.PATH = `${libDir};${process.env.PATH || ''}`;
    } else if (platform() === 'darwin') {
      env.DYLD_LIBRARY_PATH = libDir;
    } else {
      env.LD_LIBRARY_PATH = libDir;
    }
    await execFileAsync(binPath, ['--help'], { env, timeout: 10_000 });
    return { ok: true };
  } catch (err: unknown) {
    // Non-zero exit code = binary loaded and ran, just didn't like the args → pass
    if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'number') {
      return { ok: true };
    }
    // Spawn errors (ENOENT, ENAMETOOLONG, etc.) = binary can't load → fail
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Wipe all files from binDir() so a fresh download can replace them.
 * Used when falling back from CUDA to CPU build.
 */
async function clearBinDir(): Promise<void> {
  if (!existsSync(binDir())) return;
  for (const file of await readdir(binDir())) {
    try { unlinkSync(join(binDir(), file)); } catch { /* ignore */ }
  }
}

async function performBinaryDownload(binPath: string): Promise<string> {
  const candidates = await getBinaryAssetCandidates();

  for (let i = 0; i < candidates.length; i++) {
    const assetName = candidates[i];
    const isLastCandidate = i === candidates.length - 1;
    const isGpu = assetName.includes('cuda') || assetName.includes('vulkan');

    try {
      await downloadAndExtract(assetName, binPath);

      // Validate the binary actually runs
      const validation = await validateBinary(binPath);
      if (!validation.ok) {
        const reason = validation.error || 'unknown error';
        if (!isLastCandidate) {
          log({
            source: 'recall-catchup',
            level: 'warn',
            summary: `${isGpu ? 'GPU' : 'CPU'} binary failed validation: ${reason}. Trying ${candidates[i + 1].includes('cpu') ? 'CPU' : 'next'} fallback…`,
          });
          await clearBinDir();
          continue;
        }
        throw new Error(`Binary validation failed: ${reason}`);
      }

      log({
        source: 'recall-catchup',
        level: 'info',
        summary: `llama binaries ready${isGpu ? ' (GPU accelerated)' : ' (CPU)'}`,
      });
      return binPath;
    } catch (err) {
      if (!isLastCandidate) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
          source: 'recall-catchup',
          level: 'warn',
          summary: `${isGpu ? 'GPU' : 'CPU'} build failed: ${msg}. Falling back to CPU…`,
        });
        await clearBinDir();
        continue;
      }
      throw err;
    }
  }

  throw new Error('No suitable llama-embedding binary found');
}

async function downloadAndExtract(assetName: string, binPath: string): Promise<void> {
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/${assetName}`;
  const isGpu = assetName.includes('cuda') || assetName.includes('vulkan');

  mkdirSync(binDir(), { recursive: true });

  const archivePath = join(binDir(), assetName);
  const tmpPath = archivePath + '.tmp';

  log({
    source: 'recall-catchup',
    level: 'info',
    summary: `Downloading llama binaries: ${assetName}${isGpu ? ' (GPU accelerated)' : ''}`,
    data: { url, dest: binPath },
  });

  try {
    // Clean up stale .tmp
    if (existsSync(tmpPath)) unlinkSync(tmpPath);

    // Download archive
    await downloadFile(url, tmpPath);
    renameSync(tmpPath, archivePath);

    // Extract binaries + shared libraries from zip
    const tmpExtractDir = join(tmpdir(), `llama-extract-${Date.now()}`);
    mkdirSync(tmpExtractDir, { recursive: true });
    try {
      await extract(archivePath, { dir: tmpExtractDir });

      // Find the directory containing binaries — llama.cpp releases use either
      // build/bin/ (older releases) or flat root (b5300+).
      const buildBinDir = join(tmpExtractDir, 'build', 'bin');
      const sourceDir = existsSync(buildBinDir) ? buildBinDir : tmpExtractDir;

      let copiedCount = 0;
      for (const file of await readdir(sourceDir)) {
        if (!isWantedFile(file)) continue;
        const src = join(sourceDir, file);
        const dest = join(binDir(), file);
        await cp(src, dest, { force: true });
        copiedCount++;
      }

      if (copiedCount === 0) {
        throw new Error(`No binaries found in archive ${assetName}`);
      }
    } finally {
      // Clean up temp extraction directory
      try { rmSync(tmpExtractDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // Clean up archive
    if (existsSync(archivePath)) {
      try { unlinkSync(archivePath); } catch { /* ignore */ }
    }

    // Ensure executable on Unix
    if (platform() !== 'win32') {
      if (existsSync(binPath)) chmodSync(binPath, 0o755);
      const serverBin = getServerBinaryPath();
      if (existsSync(serverBin)) {
        chmodSync(serverBin, 0o755);
      }
    }

    // Post-extraction validation: the binary must exist
    if (!existsSync(binPath)) {
      throw new Error(`${BIN_NAME} not found after extracting ${assetName}`);
    }
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
  return join(modelsDir(), MODEL_FILENAME);
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
    mkdirSync(modelsDir(), { recursive: true });

    // Clean up stale .tmp from interrupted download
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }

    log({
      source: 'recall-catchup',
      level: 'info',
      summary: `Downloading embedding model: ${MODEL_FILENAME}`,
      data: { url: MODEL_URL, dest: modelPath },
    });

    await downloadFile(MODEL_URL, tmpPath);
    renameSync(tmpPath, modelPath);

    log({
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
  const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  return new Promise<void>((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    import('node:https').then(({ default: https }) => {
      const file = createWriteStream(destPath);

      const pipeResponse = (response: import('node:http').IncomingMessage) => {
        if (response.statusCode !== 200) {
          cleanup();
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        // Reset timeout on data arrival
        response.on('data', () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          timeoutHandle = setTimeout(() => {
            response.destroy();
            file.destroy();
            reject(new Error('Download timeout — no data for 30 seconds'));
          }, 30 * 1000);
        });

        response.pipe(file);
        file.on('finish', () => {
          cleanup();
          file.close();
          resolve();
        });
        file.on('error', (err) => {
          cleanup();
          reject(err);
        });
      };

      // Start overall timeout
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Download timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s`));
      }, DOWNLOAD_TIMEOUT_MS);

      https.get(url, { headers: { 'User-Agent': 'crispy' } }, (response) => {
        // Follow redirects (GitHub uses 302, HuggingFace uses 302)
        if (response.statusCode === 301 || response.statusCode === 302) {
          const location = response.headers.location;
          if (!location) {
            cleanup();
            reject(new Error('Redirect without location'));
            return;
          }
          https.get(location, { headers: { 'User-Agent': 'crispy' } }, pipeResponse).on('error', (err) => {
            cleanup();
            reject(err);
          });
          return;
        }
        pipeResponse(response);
      }).on('error', (err) => {
        cleanup();
        reject(err);
      });
    }).catch((err) => {
      cleanup();
      reject(err);
    });
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

/** Socket and PID file paths — resolved lazily (runDir() depends on test overrides). */
function getSocketPath(): string { return join(runDir(), `llama-embed-${process.pid}.sock`); }
function getPidFilePath(): string { return join(runDir(), `llama-embed-${process.pid}.pid`); }

/** Write PID file with server metadata. */
function writePidFile(pid: number, socketPath: string): void {
  writeFileSync(getPidFilePath(), JSON.stringify({
    pid,
    socketPath,
    startedAt: new Date().toISOString(),
    ownerPid: process.pid,
  }));
}

/** Remove PID file and socket. */
function cleanupPidAndSocket(): void {
  for (const f of [getPidFilePath(), getSocketPath()]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}

/** Clean up stale PID files from dead processes. */
function cleanupStalePidFiles(): void {
  if (!existsSync(runDir())) return;
  try {
    const files = readdirSync(runDir()).filter(f => f.startsWith('llama-embed-') && f.endsWith('.pid'));
    for (const f of files) {
      const pidFile = join(runDir(), f);
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

  mkdirSync(runDir(), { recursive: true });

  // Clean up any stale socket from a previous crash
  const socket = getSocketPath();
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
    log({
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

  log({
    source: 'recall-catchup',
    level: 'info',
    summary: `Starting llama-server (PID ${child.pid}, socket ${socket})`,
  });

  // Wait for /health to return 200 — bail early if the process exits
  await waitForHealth(socket, child);

  log({
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
    log({
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
    const envKey = platform() === 'darwin' ? 'DYLD_LIBRARY_PATH'
                 : platform() === 'win32' ? 'PATH'
                 : 'LD_LIBRARY_PATH';
    const env = { ...process.env };
    if (platform() === 'win32') {
      // On Windows, prepend to PATH for DLL search
      env.PATH = `${libDir};${process.env.PATH || ''}`;
    } else {
      env[envKey] = libDir;
    }
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      maxBuffer: 2 * 1024 * 1024,
      env,
    });

    if (stderr) {
      log({
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

  // Serialize embedding calls to prevent CPU contention when multiple
  // recall queries fire concurrently (e.g., 6 parallel search_transcript calls).
  return withEmbedMutex(() => embedBatchInner(texts));
}

async function embedBatchInner(texts: string[]): Promise<Float32Array[]> {
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
    log({
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
      log({
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
