/**
 * Activity Index — Persistence Layer for User Activity Data
 *
 * Owns ALL reads/writes to ~/.crispy/. No other module should touch these
 * files directly. Provides:
 * - CRUD for activity-index.jsonl (append-only index of user prompts and rosie-meta)
 * - Atomic read/write for scan-state.json (scan progress tracking)
 * - Rosie Bot metadata queries (getLatestRosieMeta)
 *
 * The activity index is an acceleration structure, not a source of truth.
 * Duplicates from crash recovery are acceptable — downstream consumers
 * dedup by timestamp + file + uuid.
 *
 * @module activity-index
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ============================================================================
// Types
// ============================================================================

/**
 * A single entry in the activity index.
 *
 * Represents a user prompt extracted from a session file. The index is
 * append-only JSONL — one JSON object per line.
 */
export interface ActivityIndexEntry {
  /** ISO 8601 timestamp of the prompt. */
  timestamp: string;
  /** Discriminator — 'prompt' for user prompts, 'rosie-meta' for Rosie Bot metadata. */
  kind: 'prompt' | 'rosie-meta';
  /** Absolute path to the JSONL session file. */
  file: string;
  /** Preview text (~120 chars). */
  preview: string;
  /** Byte offset of this entry in the JSONL file. */
  offset: number;
  /** Entry UUID for jump-to navigation (optional). */
  uuid?: string;
  /** Rosie Bot: main conversation goal (rosie-meta entries only). */
  quest?: string;
  /** Rosie Bot: most recent turn summary (rosie-meta entries only). */
  summary?: string;
  /** Rosie Bot: short conversation label (rosie-meta entries only). */
  title?: string;
}

/**
 * Per-file scan progress.
 *
 * Tracks mtime/size/offset for incremental scanning. If the file shrinks
 * (truncated), the scanner resets offset to 0 and re-scans.
 */
export interface ScanFileState {
  /** File mtime in milliseconds. */
  mtime: number;
  /** File size in bytes. */
  size: number;
  /** Byte offset where scanning left off. */
  offset: number;
}

/**
 * Root scan state persisted to scan-state.json.
 *
 * Version field for future schema migrations. Files map is keyed by
 * absolute file path.
 */
export interface ScanState {
  version: 1;
  files: Record<string, ScanFileState>;
}

// ============================================================================
// Paths
// ============================================================================

let crispyDir = join(homedir(), '.crispy');
let activityIndexPath = join(crispyDir, 'activity-index.jsonl');
let scanStatePath = join(crispyDir, 'scan-state.json');

/**
 * Override the crispy directory for testing.
 * Returns a cleanup function that restores the original paths.
 */
export function _setTestDir(dir: string): () => void {
  const prev = { crispyDir, activityIndexPath, scanStatePath };
  crispyDir = dir;
  activityIndexPath = join(dir, 'activity-index.jsonl');
  scanStatePath = join(dir, 'scan-state.json');
  rosieMetaCache = null; // Invalidate cache when paths change
  return () => {
    crispyDir = prev.crispyDir;
    activityIndexPath = prev.activityIndexPath;
    scanStatePath = prev.scanStatePath;
    rosieMetaCache = null; // Invalidate cache on restore too
  };
}

// ============================================================================
// Directory Management
// ============================================================================

/**
 * Ensure ~/.crispy/ directory exists.
 * Creates with recursive: true so intermediate dirs are also created.
 */
export function ensureCrispyDir(): void {
  fs.mkdirSync(crispyDir, { recursive: true });
}

// ============================================================================
// Scan State CRUD
// ============================================================================

/**
 * Load scan state from disk.
 *
 * Returns default { version: 1, files: {} } if:
 * - File doesn't exist
 * - File is malformed JSON
 * - File has wrong structure
 *
 * Never throws — always returns a valid ScanState.
 */
export function loadScanState(): ScanState {
  const defaultState: ScanState = { version: 1, files: {} };

  try {
    const content = fs.readFileSync(scanStatePath, 'utf-8');
    const parsed = JSON.parse(content);

    // Validate structure
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      parsed.version !== 1 ||
      typeof parsed.files !== 'object' ||
      parsed.files === null
    ) {
      return defaultState;
    }

    return parsed as ScanState;
  } catch {
    return defaultState;
  }
}

/**
 * Save scan state to disk atomically.
 *
 * Uses write-to-tmp + rename pattern to prevent corruption if the
 * process dies mid-write. The old state is preserved until the
 * rename completes.
 */
export function saveScanState(state: ScanState): void {
  ensureCrispyDir();
  const statePath = scanStatePath;
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

// ============================================================================
// Rosie Metadata Cache
// ============================================================================

/**
 * In-memory cache of the latest rosie-meta entry per session file path.
 *
 * Built lazily from a single queryActivity() call, then served from memory
 * on subsequent getLatestRosieMeta() calls. Invalidated when new rosie-meta
 * entries are appended via appendActivityEntries().
 *
 * This eliminates the N+1 readFileSync pattern during session listing —
 * previously each session triggered a full file read + parse of the
 * activity index.
 */
let rosieMetaCache: Map<string, ActivityIndexEntry> | null = null;

/** Build the cache from a single full read of the activity index. */
function buildRosieMetaCache(): Map<string, ActivityIndexEntry> {
  const entries = queryActivity(undefined, 'rosie-meta');
  const map = new Map<string, ActivityIndexEntry>();
  // Iterate forward — last entry per file wins (latest by timestamp)
  for (const e of entries) {
    if (e.quest && e.summary) {
      map.set(e.file, e);
    }
  }
  return map;
}

/** Invalidate the rosie metadata cache, forcing a rebuild on next access. */
export function invalidateRosieMetaCache(): void {
  rosieMetaCache = null;
}

// ============================================================================
// Activity Index CRUD
// ============================================================================

/**
 * Append activity entries to the index.
 *
 * Each entry is serialized as a single JSON line (JSONL format).
 * Creates the file if it doesn't exist.
 *
 * No-op if entries array is empty (file not created/modified).
 *
 * Invalidates the rosie metadata cache when rosie-meta entries are written,
 * so the next getLatestRosieMeta() call rebuilds from disk.
 */
export function appendActivityEntries(entries: ActivityIndexEntry[]): void {
  if (entries.length === 0) return;

  ensureCrispyDir();
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(activityIndexPath, lines);

  // Invalidate rosie cache when rosie-meta entries are appended
  if (entries.some((e) => e.kind === 'rosie-meta')) {
    rosieMetaCache = null;
  }
}

/**
 * Query activity entries from the index.
 *
 * Returns entries sorted by timestamp ascending. Supports optional
 * time range filtering with ISO 8601 strings and kind filtering.
 *
 * - Returns empty array if file doesn't exist
 * - Skips malformed lines gracefully (no throw)
 */
export function queryActivity(timeRange?: {
  from?: string;
  to?: string;
}, kind?: ActivityIndexEntry['kind']): ActivityIndexEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(activityIndexPath, 'utf-8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter((line) => line.trim() !== '');
  const entries: ActivityIndexEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ActivityIndexEntry;
      // Basic validation — ensure required fields exist
      if (
        typeof entry.timestamp === 'string' &&
        typeof entry.file === 'string' &&
        typeof entry.preview === 'string'
      ) {
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Apply kind filter
  let filtered = entries;
  if (kind) {
    filtered = filtered.filter((e) => e.kind === kind);
  }

  // Apply time range filter
  if (timeRange?.from) {
    filtered = filtered.filter((e) => e.timestamp >= timeRange.from!);
  }
  if (timeRange?.to) {
    filtered = filtered.filter((e) => e.timestamp <= timeRange.to!);
  }

  // Sort by timestamp ascending
  filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return filtered;
}

/**
 * Get the most recent rosie-meta entry from the activity index.
 *
 * When `filePath` is provided, returns the latest entry for that specific
 * session file. Otherwise returns the global latest.
 *
 * Uses an in-memory cache to avoid re-reading the full activity index on
 * every call. The cache is invalidated when new rosie-meta entries are
 * written via appendActivityEntries(). This reduces N per-session file
 * reads to a single read per listing cycle.
 */
export function getLatestRosieMeta(filePath?: string): ActivityIndexEntry | undefined {
  if (!rosieMetaCache) {
    rosieMetaCache = buildRosieMetaCache();
  }
  if (filePath) {
    return rosieMetaCache.get(filePath);
  }
  // No filePath = find the global latest (rare path)
  let latest: ActivityIndexEntry | undefined;
  for (const entry of rosieMetaCache.values()) {
    if (!latest || entry.timestamp > latest.timestamp) {
      latest = entry;
    }
  }
  return latest;
}
