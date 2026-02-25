/**
 * codex-jsonl-reader.ts
 *
 * JSONL file I/O for Codex CLI transcripts stored at ~/.codex/sessions/.
 * Parses the envelope format (timestamp + type + payload), scans session
 * directories, and provides fast metadata extraction.
 *
 * Responsibilities:
 * - Parse Codex JSONL files into typed envelopes
 * - Locate session files on disk by UUID
 * - Extract session metadata from the first line (fast path)
 * - Enumerate all session files sorted by mtime
 *
 * Does NOT:
 * - Adapt records to TranscriptEntry (that's codex-jsonl-adapter.ts)
 * - Perform any RPC communication
 * - Cache or manage state
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

/** Envelope wrapper for every line in a Codex JSONL transcript. */
export interface CodexJsonlEnvelope {
  timestamp: string;
  type: 'session_meta' | 'turn_context' | 'event_msg' | 'response_item';
  payload: Record<string, unknown>;
}

/** Metadata extracted from the session_meta record (first line). */
export interface CodexSessionMeta {
  id: string;
  cwd: string;
  cli_version?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
}

// ============================================================================
// Constants
// ============================================================================

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

/**
 * Match Codex session filenames and extract the UUID.
 *
 * Format: rollout-<ISO timestamp with hyphens>-<UUID>.jsonl
 * Example: rollout-2026-02-07T20-34-15-019c3ae2-9a7f-7f30-9717-d3ccfb7bac63.jsonl
 *
 * The greedy `.*-` consumes the timestamp prefix, leaving the UUID capture group.
 */
const SESSION_ID_RE = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Parse a Codex JSONL transcript file into an array of envelopes.
 *
 * Handles malformed lines (skips with console.warn), empty lines,
 * and missing trailing newlines. Matches the Claude JSONL reader pattern.
 *
 * @param filepath - Absolute path to the .jsonl file
 * @returns Array of parsed envelopes in file order
 */
export function parseCodexJsonlFile(filepath: string): CodexJsonlEnvelope[] {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    const lines = content.split('\n');
    const records: CodexJsonlEnvelope[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as CodexJsonlEnvelope;
        records.push(record);
      } catch (err) {
        console.warn(
          `[codex-jsonl-reader] Skipping unparseable line: ${(err as Error).message}`,
        );
      }
    }

    return records;
  } catch (error) {
    console.error(`[codex-jsonl-reader] Failed to read ${filepath}:`, error);
    return [];
  }
}

/**
 * Find the JSONL file on disk for a given Codex session ID.
 *
 * Scans ~/.codex/sessions/YYYY/MM/DD/ directories, matching the UUID
 * in the filename. Returns the first match (session IDs are unique).
 *
 * @param sessionId - The session UUID to search for
 * @returns Absolute path to the JSONL file, or null if not found
 */
export function findCodexSessionFile(sessionId: string): string | null {
  try {
    if (!fs.existsSync(CODEX_SESSIONS_DIR)) return null;

    // Walk YYYY/MM/DD directory tree
    for (const year of readdirSafe(CODEX_SESSIONS_DIR)) {
      const yearPath = path.join(CODEX_SESSIONS_DIR, year);
      if (!isDirectory(yearPath)) continue;

      for (const month of readdirSafe(yearPath)) {
        const monthPath = path.join(yearPath, month);
        if (!isDirectory(monthPath)) continue;

        for (const day of readdirSafe(monthPath)) {
          const dayPath = path.join(monthPath, day);
          if (!isDirectory(dayPath)) continue;

          for (const file of readdirSafe(dayPath)) {
            if (!file.endsWith('.jsonl')) continue;
            const match = file.match(SESSION_ID_RE);
            if (match && match[1] === sessionId) {
              return path.join(dayPath, file);
            }
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract session metadata by reading only the first line of a JSONL file.
 *
 * Fast path for session list population — avoids parsing the entire file.
 * The first line is always a session_meta record.
 *
 * @param filepath - Absolute path to the .jsonl file
 * @returns CodexSessionMeta or null if the file can't be read or isn't valid
 */
export function extractCodexSessionMeta(
  filepath: string,
): CodexSessionMeta | null {
  let fd: number | null = null;

  try {
    fd = fs.openSync(filepath, 'r');
    const buffer = Buffer.alloc(8192); // 8KB — plenty for session_meta
    const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
    if (bytesRead === 0) return null;

    const content = buffer.toString('utf-8', 0, bytesRead);
    const newlineIdx = content.indexOf('\n');
    const firstLine = newlineIdx >= 0 ? content.slice(0, newlineIdx) : content;

    const record = JSON.parse(firstLine.trim()) as CodexJsonlEnvelope;
    if (record.type !== 'session_meta') return null;

    const payload = record.payload;
    return {
      id: payload.id as string,
      cwd: payload.cwd as string,
      cli_version: payload.cli_version as string | undefined,
      git: payload.git as CodexSessionMeta['git'],
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Enumerate all Codex session files under ~/.codex/sessions/.
 *
 * Walks the YYYY/MM/DD directory tree, extracts session IDs from filenames,
 * and returns results sorted by mtime descending (most recent first).
 *
 * @returns Array of { sessionId, filepath, mtime } sorted by mtime desc
 */
export function scanCodexSessionFiles(): Array<{
  sessionId: string;
  filepath: string;
  mtime: number;
}> {
  const results: Array<{
    sessionId: string;
    filepath: string;
    mtime: number;
  }> = [];

  try {
    if (!fs.existsSync(CODEX_SESSIONS_DIR)) return results;

    for (const year of readdirSafe(CODEX_SESSIONS_DIR)) {
      const yearPath = path.join(CODEX_SESSIONS_DIR, year);
      if (!isDirectory(yearPath)) continue;

      for (const month of readdirSafe(yearPath)) {
        const monthPath = path.join(yearPath, month);
        if (!isDirectory(monthPath)) continue;

        for (const day of readdirSafe(monthPath)) {
          const dayPath = path.join(monthPath, day);
          if (!isDirectory(dayPath)) continue;

          for (const file of readdirSafe(dayPath)) {
            if (!file.endsWith('.jsonl')) continue;
            const match = file.match(SESSION_ID_RE);
            if (match) {
              const filepath = path.join(dayPath, file);
              try {
                const stat = fs.statSync(filepath);
                results.push({
                  sessionId: match[1],
                  filepath,
                  mtime: stat.mtimeMs,
                });
              } catch {
                // Skip files we can't stat
              }
            }
          }
        }
      }
    }
  } catch {
    // Return what we have
  }

  // Sort by mtime descending (most recent first)
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

// ============================================================================
// Helpers
// ============================================================================

function readdirSafe(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
