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

// ============================================================================
// Activity Scanning
// ============================================================================

import type { UserPromptInfo, UserActivityScanResult } from '../../agent-adapter.js';

/** Buffer size for incremental reading (64KB) */
const READ_BUFFER_SIZE = 64 * 1024;

/**
 * Scan user messages from a Codex JSONL file incrementally.
 *
 * Uses a fast-path string match before JSON.parse to skip non-user entries.
 * Returns byte offsets for each prompt to enable lazy-load response preview.
 *
 * @param filepath - Path to the JSONL file
 * @param startOffset - Byte offset to start reading from
 * @returns UserActivityScanResult with prompts and new offset
 */
export function scanCodexUserMessages(
  filepath: string,
  startOffset = 0,
): UserActivityScanResult {
  const prompts: UserPromptInfo[] = [];
  let fd: number | null = null;

  try {
    fd = fs.openSync(filepath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (startOffset >= fileSize) {
      return { prompts, offset: startOffset };
    }

    const buffer = Buffer.alloc(READ_BUFFER_SIZE);
    let currentOffset = startOffset;
    let remainder = '';
    let lastCompleteLineOffset = startOffset;
    let lineStartOffset = startOffset;

    while (currentOffset < fileSize) {
      const chunkSize = Math.min(READ_BUFFER_SIZE, fileSize - currentOffset);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, currentOffset);

      if (bytesRead === 0) break;

      const chunk = remainder + buffer.toString('utf-8', 0, bytesRead);
      const lines = chunk.split('\n');

      remainder = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // +1 for \n

        if (!trimmed) {
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
          continue;
        }

        // Fast-path: skip lines that don't contain '"role":"user"'
        if (!trimmed.includes('"role":"user"')) {
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
          continue;
        }

        // Skip developer messages
        if (trimmed.includes('"role":"developer"')) {
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
          continue;
        }

        try {
          const record = JSON.parse(trimmed) as CodexJsonlEnvelope;

          // Must be a response_item with role: user
          if (record.type !== 'response_item') {
            lineStartOffset += lineBytes;
            lastCompleteLineOffset = lineStartOffset;
            continue;
          }

          const payload = record.payload as Record<string, unknown>;
          if (payload.role !== 'user') {
            lineStartOffset += lineBytes;
            lastCompleteLineOffset = lineStartOffset;
            continue;
          }

          // Extract text from content array
          const content = payload.content as Array<Record<string, unknown>> | undefined;
          let text = '';
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'input_text' && typeof block.text === 'string') {
                text = block.text;
                break;
              }
            }
          }

          // Skip empty messages
          if (!text) {
            lineStartOffset += lineBytes;
            lastCompleteLineOffset = lineStartOffset;
            continue;
          }

          prompts.push({
            timestamp: record.timestamp || '',
            preview: text,
            offset: lineStartOffset,
            uuid: payload.id as string | undefined,
          });

          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
        } catch {
          // JSON parse error — skip the line
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
        }
      }

      currentOffset += bytesRead;
    }

    // Handle remainder (final line without trailing newline)
    if (remainder.trim()) {
      const trimmed = remainder.trim();

      if (
        trimmed.includes('"role":"user"') &&
        !trimmed.includes('"role":"developer"')
      ) {
        try {
          const record = JSON.parse(trimmed) as CodexJsonlEnvelope;

          if (record.type === 'response_item') {
            const payload = record.payload as Record<string, unknown>;
            if (payload.role === 'user') {
              const content = payload.content as Array<Record<string, unknown>> | undefined;
              let text = '';
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'input_text' && typeof block.text === 'string') {
                    text = block.text;
                    break;
                  }
                }
              }

              if (text) {
                prompts.push({
                  timestamp: record.timestamp || '',
                  preview: text,
                  offset: lineStartOffset,
                  uuid: payload.id as string | undefined,
                });
              }
            }
          }

          lastCompleteLineOffset += Buffer.byteLength(remainder, 'utf-8');
        } catch {
          // Incomplete JSON at EOF — don't advance offset past it
        }
      } else {
        // Not a user message — advance offset
        lastCompleteLineOffset += Buffer.byteLength(remainder, 'utf-8');
      }
    }

    return { prompts, offset: lastCompleteLineOffset };
  } catch {
    // File read error — return empty with original offset
    return { prompts: [], offset: startOffset };
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
 * Read the assistant response preview following a user prompt.
 *
 * Seeks to the given byte offset and reads forward to find the last
 * assistant message before the next user message or EOF. Returns
 * the text content truncated to ~200 chars, or null if no response found.
 *
 * @param filePath - Path to the JSONL file
 * @param byteOffset - Byte offset of the user prompt to start after
 * @returns Preview text of the assistant response, or null
 */
export function readCodexResponsePreview(
  filePath: string,
  byteOffset: number,
): string | null {
  let fd: number | null = null;

  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (byteOffset >= fileSize) {
      return null;
    }

    const buffer = Buffer.alloc(READ_BUFFER_SIZE);
    let currentOffset = byteOffset;
    let remainder = '';
    let lastAssistantText: string | null = null;
    let skippedFirstLine = false;

    while (currentOffset < fileSize) {
      const chunkSize = Math.min(READ_BUFFER_SIZE, fileSize - currentOffset);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, currentOffset);

      if (bytesRead === 0) break;

      const chunk = remainder + buffer.toString('utf-8', 0, bytesRead);
      const lines = chunk.split('\n');

      remainder = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Skip the first line (the user prompt we started at)
        if (!skippedFirstLine) {
          skippedFirstLine = true;
          continue;
        }

        // Stop at next user message
        if (trimmed.includes('"role":"user"') && !trimmed.includes('"role":"developer"')) {
          return lastAssistantText;
        }

        // Check for assistant message
        if (trimmed.includes('"role":"assistant"')) {
          try {
            const record = JSON.parse(trimmed) as CodexJsonlEnvelope;

            if (record.type === 'response_item') {
              const payload = record.payload as Record<string, unknown>;
              if (payload.role === 'assistant') {
                const content = payload.content as Array<Record<string, unknown>> | undefined;
                if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === 'output_text' && typeof block.text === 'string') {
                      const text = block.text;
                      lastAssistantText = text.length > 200 ? text.slice(0, 200) : text;
                      break;
                    }
                  }
                }
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      currentOffset += bytesRead;
    }

    // Handle remainder
    if (remainder.trim()) {
      const trimmed = remainder.trim();

      // Check for user message (stop condition)
      if (trimmed.includes('"role":"user"') && !trimmed.includes('"role":"developer"')) {
        return lastAssistantText;
      }

      // Check for assistant message
      if (trimmed.includes('"role":"assistant"')) {
        try {
          const record = JSON.parse(trimmed) as CodexJsonlEnvelope;

          if (record.type === 'response_item') {
            const payload = record.payload as Record<string, unknown>;
            if (payload.role === 'assistant') {
              const content = payload.content as Array<Record<string, unknown>> | undefined;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'output_text' && typeof block.text === 'string') {
                    const text = block.text;
                    lastAssistantText = text.length > 200 ? text.slice(0, 200) : text;
                    break;
                  }
                }
              }
            }
          }
        } catch {
          // Incomplete JSON at EOF
        }
      }
    }

    return lastAssistantText;
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

// ============================================================================
// Turn Content Retrieval
// ============================================================================

/** Maximum bytes per field to avoid blowup from thinking blocks / file rewrites. */
const TURN_CONTENT_CAP = 8 * 1024;

/**
 * Extract ALL text blocks from a Codex response_item's content array.
 *
 * Concatenates all text blocks (input_text for user, output_text for assistant)
 * rather than returning just the first one.
 */
function extractAllCodexText(
  content: Array<Record<string, unknown>> | undefined,
  textType: 'input_text' | 'output_text',
): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === textType && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/** Same shape as Claude's TurnContent — kept as alias for vendor-prefixed exports. */
export type CodexTurnContent = import('../claude/jsonl-reader.js').TurnContent;

/**
 * Read the full user prompt and assistant response for a specific turn.
 *
 * Seeks to the given byte offset, parses the user prompt on the first line,
 * then reads forward collecting ALL assistant text blocks until the next
 * user message or EOF. Returns full text capped at 8KB per field.
 *
 * @param filePath - Path to the JSONL file
 * @param byteOffset - Byte offset of the user prompt
 * @returns Full turn content, or null on error
 */
export function readCodexTurnContent(
  filePath: string,
  byteOffset: number,
): CodexTurnContent | null {
  let fd: number | null = null;

  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (byteOffset >= fileSize) return null;

    const buffer = Buffer.alloc(READ_BUFFER_SIZE);
    let currentOffset = byteOffset;
    let remainder = '';
    let userPrompt: string | null = null;
    const assistantParts: string[] = [];
    let parsedFirstLine = false;

    while (currentOffset < fileSize) {
      const chunkSize = Math.min(READ_BUFFER_SIZE, fileSize - currentOffset);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, currentOffset);
      if (bytesRead === 0) break;

      const chunk = remainder + buffer.toString('utf-8', 0, bytesRead);
      const lines = chunk.split('\n');
      remainder = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // First line is the user prompt at the offset
        if (!parsedFirstLine) {
          parsedFirstLine = true;
          try {
            const record = JSON.parse(trimmed) as CodexJsonlEnvelope;
            if (record.type === 'response_item') {
              const payload = record.payload as Record<string, unknown>;
              const content = payload.content as Array<Record<string, unknown>> | undefined;
              const text = extractAllCodexText(content, 'input_text');
              userPrompt = text.slice(0, TURN_CONTENT_CAP) || null;
            }
          } catch {
            return null;
          }
          continue;
        }

        // Stop at next user message
        if (trimmed.includes('"role":"user"') && !trimmed.includes('"role":"developer"')) {
          break;
        }

        // Collect assistant text
        if (trimmed.includes('"role":"assistant"')) {
          try {
            const record = JSON.parse(trimmed) as CodexJsonlEnvelope;
            if (record.type === 'response_item') {
              const payload = record.payload as Record<string, unknown>;
              if (payload.role === 'assistant') {
                const content = payload.content as Array<Record<string, unknown>> | undefined;
                const text = extractAllCodexText(content, 'output_text');
                if (text) assistantParts.push(text);
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      currentOffset += bytesRead;
    }

    // Handle remainder
    if (remainder.trim() && parsedFirstLine) {
      const trimmed = remainder.trim();
      if (trimmed.includes('"role":"assistant"') && !trimmed.includes('"role":"user"')) {
        try {
          const record = JSON.parse(trimmed) as CodexJsonlEnvelope;
          if (record.type === 'response_item') {
            const payload = record.payload as Record<string, unknown>;
            if (payload.role === 'assistant') {
              const content = payload.content as Array<Record<string, unknown>> | undefined;
              const text = extractAllCodexText(content, 'output_text');
              if (text) assistantParts.push(text);
            }
          }
        } catch {
          // Incomplete JSON at EOF
        }
      }
    }

    if (!userPrompt) return null;

    const fullAssistant = assistantParts.join('\n\n');
    return {
      userPrompt,
      assistantResponse: fullAssistant
        ? fullAssistant.slice(0, TURN_CONTENT_CAP)
        : null,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
