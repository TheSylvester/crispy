/**
 * Activity Index — Persistence Layer for User Activity Data
 *
 * Owns ALL reads/writes to ~/.crispy/. No other module should touch these
 * files directly. Provides:
 * - CRUD for activity-index.jsonl (append-only index of user prompts)
 * - Atomic read/write for scan-state.json (scan progress tracking)
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
  /** Discriminator for future expansion (quest, state, etc.). */
  kind: 'prompt';
  /** Absolute path to the JSONL session file. */
  file: string;
  /** Preview text (~120 chars). */
  preview: string;
  /** Byte offset of this entry in the JSONL file. */
  offset: number;
  /** Entry UUID for jump-to navigation (optional). */
  uuid?: string;
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
  return () => {
    crispyDir = prev.crispyDir;
    activityIndexPath = prev.activityIndexPath;
    scanStatePath = prev.scanStatePath;
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
// Activity Index CRUD
// ============================================================================

/**
 * Append activity entries to the index.
 *
 * Each entry is serialized as a single JSON line (JSONL format).
 * Creates the file if it doesn't exist.
 *
 * No-op if entries array is empty (file not created/modified).
 */
export function appendActivityEntries(entries: ActivityIndexEntry[]): void {
  if (entries.length === 0) return;

  ensureCrispyDir();
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(activityIndexPath, lines);
}

/**
 * Query activity entries from the index.
 *
 * Returns entries sorted by timestamp ascending. Supports optional
 * time range filtering with ISO 8601 strings.
 *
 * - Returns empty array if file doesn't exist
 * - Skips malformed lines gracefully (no throw)
 */
export function queryActivity(timeRange?: {
  from?: string;
  to?: string;
}): ActivityIndexEntry[] {
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

  // Apply time range filter
  let filtered = entries;
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
