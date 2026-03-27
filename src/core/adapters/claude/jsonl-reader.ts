// ============================================================================
// JSONL Reader
// Parses Claude Code transcript files for history display
//
// All types here are Claude-specific — they model Claude Code's JSONL format
// for session discovery and incremental parsing. The universal vendor-agnostic
// types live in transcript.ts.
// ============================================================================

import * as fs from "fs";
import * as crypto from "crypto";
import { log } from '../../log.js';

// ============================================================================
// Claude JSONL Types (private to this module)
// ============================================================================

/** Entry types that appear in Claude Code JSONL transcripts. */
type ClaudeEntryType =
  | "user"
  | "assistant"
  | "system"
  | "attachment"
  | "summary"
  | "custom-title"
  | "result"
  | "stream_event"
  | "progress"
  | "queue-operation"
  | "file-history-snapshot";

/** Minimal content block shape for Claude JSONL parsing. */
interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: {
    type: string;
    media_type?: string;
    data?: string;
  };
  tool_use_id?: string;
  content?: string | ClaudeContentBlock[];
  is_error?: boolean;
  [key: string]: unknown;
}

/** A single row from a Claude Code .jsonl transcript file. */
export interface ClaudeTranscriptEntry {
  type: ClaudeEntryType;
  uuid?: string;
  sessionId?: string;
  parentUuid?: string;
  isMeta?: boolean;
  timestamp?: string;
  message?: {
    role?: string;
    content: string | ClaudeContentBlock[];
    id?: string;
  };
  leafUuid?: string;
  summary?: string;
  customTitle?: string;
  messageId?: string;
  snapshot?: {
    messageId: string;
    trackedFileBackups: {
      [filename: string]: { backupFileName: string };
    };
  };
  // Sub-agent fields (used by isSidechainSession, detectAgentChildren)
  isSidechain?: boolean;
  agentId?: string;
  toolUseResult?: {
    agentId?: string;
    [key: string]: unknown;
  };
  // Working directory
  cwd?: string;
  [key: string]: unknown;
}

/** Incremental JSONL parsing state for a single file. */
export interface ClaudeFileReadState {
  filepath: string;
  mtime: number;
  size: number;
  entryCount: number;
  entries: ClaudeTranscriptEntry[];
  offset?: number;
  inode?: number;
}

// ============================================================================
// Session Metadata (Claude-specific session discovery)
// ============================================================================

export type ClaudeSessionType = "session" | "agent";

export interface ClaudeSessionMeta {
  id: string;
  type: ClaudeSessionType;
  active: boolean;
  mtime: number;
  size: number;
  label: string;
  toolCount: number;
  messageCount: number;
  isSidechain?: boolean;
  parentId?: string;
  children: string[];
  projectSlug: string;
  worktree: string;
  etag: string;
  lastMessage?: string;
}

export interface ClaudeQuickMeta {
  label: string;
  isSidechain: boolean;
  isTrivial: boolean;
  parentSessionId?: string;
  lastMessage?: string;
  /** Real absolute project path extracted from the `cwd` field of JSONL entries. */
  projectPath?: string;
  /** ISO timestamp from the most recent transcript entry (for accurate sort order). */
  lastTimestamp?: string;
}

/** Structured metadata extracted from the tail (last 32KB) of a JSONL file. */
export interface TailMetadata {
  lastMessage?: string; // last user/assistant text
  summary?: string; // from type:"summary" entry (AI-generated title)
  slug?: string; // three-word session name from any entry
  lastTimestamp?: string; // ISO timestamp from most recent entry
  cwd?: string; // project path from any entry with a cwd field
}

// ============================================================================
// Incremental JSONL Reading
// ============================================================================

// Default buffer size for incremental reading (64KB)
const READ_BUFFER_SIZE = 64 * 1024;

/**
 * Result from reading lines starting at an offset
 */
interface ReadLinesResult {
  entries: ClaudeTranscriptEntry[];
  newOffset: number;
}

/**
 * Read JSONL entries from a file starting at a byte offset.
 *
 * Uses synchronous file operations and buffer-based reading.
 * Handles incomplete lines at EOF by not advancing the offset past them.
 *
 * @param filepath - Path to the JSONL file
 * @param startOffset - Byte offset to start reading from
 * @returns Object with parsed entries and new offset position
 */
export function readLinesFromOffset(
  filepath: string,
  startOffset: number,
): ReadLinesResult {
  const entries: ClaudeTranscriptEntry[] = [];
  let fd: number | null = null;

  try {
    fd = fs.openSync(filepath, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    // Nothing to read if we're already at or past EOF
    if (startOffset >= fileSize) {
      return { entries, newOffset: startOffset };
    }

    // Read remaining content into buffer
    const bytesToRead = fileSize - startOffset;
    const buffer = Buffer.alloc(Math.min(bytesToRead, READ_BUFFER_SIZE * 16)); // Cap at 1MB chunks
    let currentOffset = startOffset;
    let remainder = "";
    let lastCompleteLineOffset = startOffset;

    // Read in chunks and process lines
    while (currentOffset < fileSize) {
      const chunkSize = Math.min(READ_BUFFER_SIZE, fileSize - currentOffset);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, currentOffset);

      if (bytesRead === 0) {
        break; // EOF
      }

      currentOffset += bytesRead;

      // Combine remainder from previous chunk with new data
      const chunk = remainder + buffer.toString("utf-8", 0, bytesRead);
      const lines = chunk.split("\n");

      // Last element may be incomplete (no trailing newline)
      remainder = lines.pop() || "";

      // Process complete lines
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          // Empty line - advance offset past it
          lastCompleteLineOffset += Buffer.byteLength(line + "\n", "utf-8");
          continue;
        }

        try {
          const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;
          entries.push(entry);
          // Advance offset past this successfully parsed line
          lastCompleteLineOffset += Buffer.byteLength(line + "\n", "utf-8");
        } catch (err) {
          // JSON parse error - skip it and continue
          log({ level: 'warn', source: 'jsonl-reader', summary: `Skipping unparseable line: ${(err as Error).message}` });
          lastCompleteLineOffset += Buffer.byteLength(line + "\n", "utf-8");
          continue;
        }
      }
    }

    // Handle remainder (final line without trailing newline)
    if (remainder.trim()) {
      try {
        const entry = JSON.parse(remainder.trim()) as ClaudeTranscriptEntry;
        entries.push(entry);
        // Successfully parsed - advance offset to end
        lastCompleteLineOffset += Buffer.byteLength(remainder, "utf-8");
      } catch {
        // Incomplete JSON at EOF - don't advance offset past it
        // The next read will retry parsing this line
      }
    }

    return { entries, newOffset: lastCompleteLineOffset };
  } catch {
    // File read error - return empty with original offset
    return { entries: [], newOffset: startOffset };
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
// Activity Scanning
// ============================================================================

import type { UserPromptInfo, UserActivityScanResult } from '../../agent-adapter.js';

/**
 * Scan user messages from a Claude JSONL file incrementally.
 *
 * Uses a fast-path string match before JSON.parse to skip non-user entries.
 * Filters out meta entries (isMeta, toolUseResult) and warmup messages.
 * Returns byte offsets for each prompt to enable lazy-load response preview.
 *
 * @param filepath - Path to the JSONL file
 * @param startOffset - Byte offset to start reading from
 * @returns UserActivityScanResult with prompts and new offset
 */
export function scanUserMessages(
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

        // Fast-path: skip lines that don't contain '"type":"user"'
        if (!trimmed.includes('"type":"user"')) {
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
          continue;
        }

        // Also skip meta entries and tool results
        if (trimmed.includes('"isMeta":true') || trimmed.includes('"toolUseResult"')) {
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
          continue;
        }

        try {
          const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;

          if (entry.type === 'user' && !entry.isMeta && !entry.toolUseResult) {
            const text = extractMessageText(entry);

            // Skip warmup messages
            if (text === 'Warmup') {
              lineStartOffset += lineBytes;
              lastCompleteLineOffset = lineStartOffset;
              continue;
            }

            // Skip empty messages
            if (!text) {
              lineStartOffset += lineBytes;
              lastCompleteLineOffset = lineStartOffset;
              continue;
            }

            prompts.push({
              timestamp: entry.timestamp || '',
              preview: text,
              offset: lineStartOffset,
              uuid: entry.uuid,
            });
          }

          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
        } catch {
          // JSON parse error — skip the line
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
        }
      }

      currentOffset += bytesRead;

      // Note: remainder (incomplete line at chunk boundary) is not counted
      // toward lastCompleteLineOffset — it will be re-parsed on the next call.
    }

    // Handle remainder (final line without trailing newline)
    if (remainder.trim()) {
      const trimmed = remainder.trim();

      // Same fast-path checks
      if (
        trimmed.includes('"type":"user"') &&
        !trimmed.includes('"isMeta":true') &&
        !trimmed.includes('"toolUseResult"')
      ) {
        try {
          const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;

          if (entry.type === 'user' && !entry.isMeta && !entry.toolUseResult) {
            const text = extractMessageText(entry);

            if (text && text !== 'Warmup') {
              prompts.push({
                timestamp: entry.timestamp || '',
                preview: text,
                offset: lineStartOffset,
                uuid: entry.uuid,
              });
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
 * Read the first N user message UUIDs from a JSONL file.
 * Returns [{uuid, offset}] pairs. Used for fork lineage detection.
 * Lightweight — stops after finding N user messages with non-null UUIDs, no full parse.
 *
 * @param filePath - Path to the JSONL file
 * @param count - Maximum number of UUIDs to collect
 * @returns Array of {uuid, offset} pairs
 */
export function scanFirstUserUuids(
  filePath: string,
  count: number,
): Array<{ uuid: string; offset: number }> {
  const results: Array<{ uuid: string; offset: number }> = [];
  let fd: number | null = null;

  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) return results;

    const buffer = Buffer.alloc(READ_BUFFER_SIZE);
    let currentOffset = 0;
    let remainder = '';
    let lineStartOffset = 0;

    while (currentOffset < fileSize && results.length < count) {
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
          continue;
        }

        // Fast-path: skip non-user entries
        if (!trimmed.includes('"type":"user"')) {
          lineStartOffset += lineBytes;
          continue;
        }

        // Skip meta entries and tool results
        if (trimmed.includes('"isMeta":true') || trimmed.includes('"toolUseResult"')) {
          lineStartOffset += lineBytes;
          continue;
        }

        try {
          const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;

          if (entry.type === 'user' && !entry.isMeta && !entry.toolUseResult && entry.uuid) {
            results.push({ uuid: entry.uuid, offset: lineStartOffset });
            if (results.length >= count) break;
          }
        } catch {
          // Skip malformed lines
        }

        lineStartOffset += lineBytes;
      }

      currentOffset += bytesRead;
    }

    return results;
  } catch {
    return results;
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
 * Scan forward through a JSONL file, checking each user message UUID
 * against a set of known parent UUIDs. Returns the byte offset of the
 * first user message whose UUID is NOT in the parent set.
 *
 * If all user messages match the parent set, returns the end-of-file offset
 * (meaning the entire file is shared content).
 *
 * @param filePath - Path to the JSONL file
 * @param parentUuids - Set of UUIDs from the parent session
 * @returns Byte offset where the fork diverges
 */
export function findDivergenceOffset(
  filePath: string,
  parentUuids: Set<string>,
): { offset: number; lastSharedUuid: string | null } {
  let fd: number | null = null;
  let lastSharedUuid: string | null = null;

  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) return { offset: 0, lastSharedUuid: null };

    const buffer = Buffer.alloc(READ_BUFFER_SIZE);
    let currentOffset = 0;
    let remainder = '';
    let lineStartOffset = 0;

    while (currentOffset < fileSize) {
      const chunkSize = Math.min(READ_BUFFER_SIZE, fileSize - currentOffset);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, currentOffset);

      if (bytesRead === 0) break;

      const chunk = remainder + buffer.toString('utf-8', 0, bytesRead);
      const lines = chunk.split('\n');

      remainder = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;

        if (!trimmed) {
          lineStartOffset += lineBytes;
          continue;
        }

        // Fast-path: only check user entries for divergence
        if (!trimmed.includes('"type":"user"')) {
          lineStartOffset += lineBytes;
          continue;
        }

        if (trimmed.includes('"isMeta":true') || trimmed.includes('"toolUseResult"')) {
          lineStartOffset += lineBytes;
          continue;
        }

        try {
          const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;

          if (entry.type === 'user' && !entry.isMeta && !entry.toolUseResult && entry.uuid) {
            if (!parentUuids.has(entry.uuid)) {
              // Found the divergence point — this is the first new message
              return { offset: lineStartOffset, lastSharedUuid };
            }
            lastSharedUuid = entry.uuid;
          }
        } catch {
          // Skip malformed lines
        }

        lineStartOffset += lineBytes;
      }

      currentOffset += bytesRead;
    }

    // All user messages matched the parent — entire file is shared
    return { offset: lineStartOffset, lastSharedUuid };
  } catch {
    return { offset: 0, lastSharedUuid: null };
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
export function readResponsePreview(
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

        // Stop at next real user message (not meta, not tool result)
        if (
          trimmed.includes('"type":"user"') &&
          !trimmed.includes('"isMeta":true') &&
          !trimmed.includes('"toolUseResult"')
        ) {
          // Found next user message — return what we have
          return lastAssistantText;
        }

        // Check for assistant message
        if (trimmed.includes('"type":"assistant"')) {
          try {
            const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;
            if (entry.type === 'assistant') {
              const text = extractMessageText(entry);
              if (text) {
                lastAssistantText = text.length > 200 ? text.slice(0, 200) : text;
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

      // Check for user message (stop condition) — same logic as above
      if (
        trimmed.includes('"type":"user"') &&
        !trimmed.includes('"isMeta":true') &&
        !trimmed.includes('"toolUseResult"')
      ) {
        return lastAssistantText;
      }

      // Check for assistant message
      if (trimmed.includes('"type":"assistant"')) {
        try {
          const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;
          if (entry.type === 'assistant') {
            const text = extractMessageText(entry);
            if (text) {
              lastAssistantText = text.length > 200 ? text.slice(0, 200) : text;
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
 * Extract ALL text blocks from a Claude transcript entry's content array.
 *
 * Unlike extractMessageText() which returns only the first text block,
 * this concatenates all text blocks — important for assistant turns that
 * interleave text blocks with tool_use blocks.
 */
function extractAllText(entry: ClaudeTranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

export interface TurnContent {
  userPrompt: string;
  assistantResponse: string | null;
}

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
export function readClaudeTurnContent(
  filePath: string,
  byteOffset: number,
): TurnContent | null {
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

      let hitUserBoundary = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // First line is the user prompt at the offset
        if (!parsedFirstLine) {
          parsedFirstLine = true;
          try {
            const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;
            const text = extractAllText(entry);
            userPrompt = text.slice(0, TURN_CONTENT_CAP) || null;
          } catch {
            return null; // Can't parse the line at this offset
          }
          continue;
        }

        // Stop at next real user message
        if (
          trimmed.includes('"type":"user"') &&
          !trimmed.includes('"isMeta":true') &&
          !trimmed.includes('"toolUseResult"')
        ) {
          hitUserBoundary = true;
          break;
        }

        // Collect assistant text
        if (trimmed.includes('"type":"assistant"')) {
          try {
            const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;
            if (entry.type === 'assistant') {
              const text = extractAllText(entry);
              if (text) assistantParts.push(text);
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      if (hitUserBoundary) break;

      currentOffset += bytesRead;
    }

    // Handle remainder
    if (remainder.trim() && parsedFirstLine) {
      const trimmed = remainder.trim();
      if (trimmed.includes('"type":"assistant"')) {
        try {
          const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;
          if (entry.type === 'assistant') {
            const text = extractAllText(entry);
            if (text) assistantParts.push(text);
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

/**
 * Read JSONL file incrementally, only parsing new content since last read.
 *
 * This function implements efficient incremental parsing to avoid re-reading
 * entire files on each refresh. It tracks:
 * - Byte offset for resuming reads
 * - Inode for detecting file replacement
 * - Size for detecting truncation
 *
 * Memory usage is O(new entries) rather than O(file size).
 *
 * @param filepath - Path to the JSONL file
 * @param existingState - Previously cached state (if any)
 * @returns Updated ClaudeFileReadState with new entries appended
 */
export function readJsonlIncremental(
  filepath: string,
  existingState?: ClaudeFileReadState,
): ClaudeFileReadState {
  // Handle file not found
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filepath);
  } catch {
    // File doesn't exist - return empty state
    return {
      filepath,
      mtime: 0,
      size: 0,
      entryCount: 0,
      entries: [],
      offset: 0,
      inode: 0,
    };
  }

  // Get cached values or defaults
  const cachedMtime = existingState?.mtime ?? 0;
  const cachedSize = existingState?.size ?? 0;
  const cachedOffset = existingState?.offset ?? 0;
  const cachedInode = existingState?.inode ?? 0;
  const cachedEntries = existingState?.entries ?? [];

  let startOffset = cachedOffset;

  // Detect file replacement (inode changed) - force full reread
  // On Windows, stat.ino may be 0 or unreliable, so also check mtime+size
  if (existingState && cachedInode !== 0 && cachedInode !== stat.ino) {
    startOffset = 0;
  }

  // Check if file unchanged (same mtime, size, and inode)
  if (
    cachedMtime === stat.mtimeMs &&
    cachedSize === stat.size &&
    (cachedInode === 0 || cachedInode === stat.ino)
  ) {
    // Return existing state unchanged (add offset/inode if missing)
    return {
      ...existingState!,
      offset: cachedOffset,
      inode: stat.ino,
    };
  }

  // Check if file was truncated (size decreased)
  if (stat.size < cachedSize) {
    startOffset = 0;
  }

  // Read new content starting from offset
  const result = readLinesFromOffset(filepath, startOffset);

  // Combine with existing entries if appending, or replace if reset
  const allEntries =
    startOffset === 0 ? result.entries : [...cachedEntries, ...result.entries];

  return {
    filepath,
    mtime: stat.mtimeMs,
    size: stat.size,
    entryCount: allEntries.length,
    entries: allEntries,
    offset: result.newOffset,
    inode: stat.ino,
  };
}

/**
 * Parse a JSONL file (one JSON object per line).
 *
 * Handles:
 * - Invalid JSON lines (skips silently)
 * - Empty lines
 * - Missing final newline
 *
 * @param filepath - Path to the .jsonl file
 * @returns Array of parsed ClaudeTranscriptEntry objects
 */
export function parseJsonlFile(filepath: string): ClaudeTranscriptEntry[] {
  try {
    const content = fs.readFileSync(filepath, "utf-8");
    const lines = content.split("\n");
    const entries: ClaudeTranscriptEntry[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue; // Skip empty lines
      }
      try {
        const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;
        entries.push(entry);
      } catch (err) {
        // Skip invalid JSON lines
        log({ level: 'warn', source: 'claude:jsonl-reader', summary: `Skipping unparseable line: ${(err as Error).message}` });
        continue;
      }
    }

    return entries;
  } catch (error) {
    log({ level: 'error', source: 'jsonl-reader', summary: `Failed to read JSONL file ${filepath}: ${error instanceof Error ? error.message : String(error)}`, data: { filepath, error: String(error) } });
    return [];
  }
}

// ============================================================================
// Init Model Extraction (for resume-time model population)
// ============================================================================

/**
 * Extract the model string from the init entry in a Claude JSONL file.
 *
 * Reads only the first 8KB of the file to find the `type: "system"` +
 * `subtype: "init"` entry, which contains the `model` field. This avoids
 * parsing the entire transcript just to discover which model was used.
 *
 * @param filepath - Absolute path to the .jsonl file
 * @returns The model string (e.g. "claude-sonnet-4-20250514"), or undefined
 */
export function extractInitModel(filepath: string): string | undefined {
  let fd: number | null = null;

  try {
    fd = fs.openSync(filepath, 'r');
    const stat = fs.fstatSync(fd);
    const bytesToRead = Math.min(stat.size, 8 * 1024);

    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);

    if (bytesRead === 0) return undefined;

    const content = buffer.toString('utf-8', 0, bytesRead);
    const lines = content.split('\n');

    // Drop last line if it might be truncated at the chunk boundary
    if (bytesRead === bytesToRead && !content.endsWith('\n')) {
      lines.pop();
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;
        if (entry.type === 'system' && entry['subtype'] === 'init') {
          const model = entry['model'];
          return typeof model === 'string' ? model : undefined;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  } catch {
    return undefined;
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
// Entry Analysis Helpers
// ============================================================================

/**
 * Extract the label for a session from entries.
 *
 * Priority order:
 * 1. customTitle from type: "custom-title" entry
 * 2. summary from type: "summary" entry
 * 3. First user message content (truncated to 45 chars)
 *
 * @param entries - Array of transcript entries
 * @returns Session label (max 45 chars)
 */
export function extractLabel(entries: ClaudeTranscriptEntry[]): string {
  // 1. Check for custom-title entry
  const customTitleEntry = entries.find((e) => e.type === "custom-title");
  if (customTitleEntry?.customTitle) {
    return customTitleEntry.customTitle;
  }

  // 2. Check for summary entry
  const summaryEntry = entries.find((e) => e.type === "summary");
  if (summaryEntry?.summary) {
    return summaryEntry.summary;
  }

  // 3. Extract from first user message
  const firstUserMessage = entries.find((e) => e.type === "user" && !e.isMeta);
  if (firstUserMessage?.message?.content) {
    let text = "";
    const content = firstUserMessage.message.content;

    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      // Find last text block
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i];
        if (block.type === "text" && block.text) {
          text = block.text;
          break;
        }
      }
    }

    // Normalize: remove newlines and trim (CSS handles truncation via ellipsis)
    text = text.replace(/\n/g, " ").trim();
    return text || "No prompt";
  }

  return "No prompt";
}

/**
 * Count tool_use blocks in entries.
 *
 * @param entries - Array of transcript entries
 * @returns Number of tool_use content blocks
 */
export function countToolUses(entries: ClaudeTranscriptEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use") {
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Count user and assistant messages (non-meta entries).
 *
 * @param entries - Array of transcript entries
 * @returns Number of messages
 */
export function countMessages(entries: ClaudeTranscriptEntry[]): number {
  return entries.filter(
    (e) => (e.type === "user" || e.type === "assistant") && !e.isMeta,
  ).length;
}

/**
 * Check if session is a sidechain (non-primary branch).
 *
 * @param entries - Array of transcript entries
 * @returns true if this is a sidechain session
 */
export function isSidechainSession(entries: ClaudeTranscriptEntry[]): boolean {
  // Check first message for isSidechain flag
  const firstMessage = entries[0];
  return firstMessage?.type === "user" && firstMessage?.isSidechain === true;
}

/**
 * Extract plain text from an entry's message.content.
 *
 * Handles both content forms:
 * - String: `content: "Warmup"`
 * - Array: `content: [{ type: "text", text: "Warmup" }]`
 *
 * @param entry - Transcript entry with a message
 * @returns Extracted text, or empty string if none found
 */
function extractMessageText(entry: ClaudeTranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text) {
        return block.text;
      }
    }
  }
  return "";
}

/**
 * Detect whether a session is trivial (warmup, empty, or interrupted).
 *
 * Trivial sessions are SDK artifacts that clutter the session list:
 * - Empty files (0 entries, 0 bytes)
 * - Sessions with no user/assistant messages (queue-ops, system-only, etc.)
 * - Sub-agent warmup sessions ("Warmup" user prompt ± tool-use round-trips)
 * - Immediately interrupted sessions (user prompt + interrupt, no response)
 *
 * @param entries - Parsed transcript entries from the first chunk
 * @param fileSize - Total file size in bytes (from stat)
 * @returns true if the session is trivial and should be hidden
 */
export function isTrivialSession(
  entries: ClaudeTranscriptEntry[],
  fileSize: number,
): boolean {
  // 1. Empty file — trivial
  if (entries.length === 0 && fileSize === 0) {
    return true;
  }

  // 2. Unparseable file (bytes on disk but no parsed entries) — show it
  if (entries.length === 0 && fileSize > 0) {
    return false;
  }

  // Filter to actual user/assistant messages (skip meta entries)
  const messages = entries.filter(
    (e) => (e.type === "user" || e.type === "assistant") && !e.isMeta,
  );

  // 3. No user/assistant messages at all.
  //    But if the file is larger than the typical read buffer (64KB),
  //    entries are likely incomplete — a large entry (e.g. base64 image)
  //    exceeded the first-chunk read. Don't classify as trivial.
  if (messages.length === 0) {
    return fileSize <= 64 * 1024;
  }

  // Real user prompts: user entries that aren't tool_result responses.
  // Tool-result user entries carry toolUseResult (truthy) or have content
  // blocks that are all type "tool_result". These are machine-generated
  // round-trips, not human prompts.
  const userPrompts = messages.filter(
    (e) => e.type === "user" && !e.toolUseResult,
  );

  // 4. Warmup session: only real user prompt is "Warmup".
  //    Extended warmups may have many tool-use round-trips but still
  //    only one human prompt — the "Warmup" message.
  if (
    userPrompts.length === 1 &&
    extractMessageText(userPrompts[0]) === "Warmup"
  ) {
    return true;
  }

  // 5. Interrupted before response: user message(s) but NO assistant,
  //    and total entries ≤ 3 (e.g. queue-op + user + "[Request interrupted]")
  const hasAssistant = messages.some((e) => e.type === "assistant");
  if (!hasAssistant && entries.length <= 3) {
    return true;
  }

  // 6. Ephemeral child session (Rosie summarize, recall agent, etc.)
  //    The SDK writes JSONL files to disk even for `persistSession: false`
  //    sessions. Detect these by checking if the first queue-operation's
  //    content starts with a known ephemeral prompt prefix. We control
  //    these prompts, so matching the prefix is reliable.
  const firstQueueOp = entries.find(
    (e) => e.type === "queue-operation" && (e as Record<string, unknown>).content,
  );
  if (firstQueueOp) {
    const content = String((firstQueueOp as Record<string, unknown>).content);
    if (
      content.startsWith("Consider this entire conversation so far.") || // Rosie summarize (legacy)
      content.startsWith("## Opening turns") || // Rosie bot summarize (bookend format)
      content.startsWith("You are a project tracker.") || // Rosie bot tracker
      content.startsWith("You are a memory recall agent.") // Recall agent
    ) {
      return true;
    }
  }

  // Everything else — not trivial
  return false;
}

// ============================================================================
// Fast Metadata Extraction (Performance Optimization)
// ============================================================================

/**
 * Generate an etag for a session based on mtime, size, and entry count.
 *
 * Format: md5(mtime:size:entryCount).slice(0, 8)
 *
 * @param mtime - File modification time (seconds)
 * @param size - File size in bytes
 * @param entryCount - Number of entries in the file
 * @returns 8-character hex string
 */
export function generateEtag(
  mtime: number,
  size: number,
  entryCount: number,
): string {
  const data = `${mtime}:${size}:${entryCount}`;
  const hash = crypto.createHash("md5").update(data).digest("hex");
  return hash.slice(0, 8);
}

/**
 * Extract session metadata by reading only the first chunk of a file.
 *
 * This function is designed for fast session list population. It reads only
 * the first maxBytes (default 64KB) of the file, which typically contains
 * the label-relevant entries (custom-title, summary, or first user message)
 * while avoiding the expensive parsing of progress entries that make up
 * the bulk of large transcript files.
 *
 * Performance: Reads 64KB vs 236MB for large files = ~4000x faster
 *
 * @param filepath - Path to the JSONL file
 * @param maxBytes - Maximum bytes to read (default 64KB)
 * @returns ClaudeQuickMeta with label and isSidechain, or null on error
 */
export function extractMetadataFast(
  filepath: string,
  maxBytes = 64 * 1024,
): ClaudeQuickMeta | null {
  let fd: number | null = null;

  try {
    fd = fs.openSync(filepath, "r");
    const stat = fs.fstatSync(fd);
    const bytesToRead = Math.min(stat.size, maxBytes);

    // Read first chunk
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);

    if (bytesRead === 0) {
      return {
        label: "No prompt",
        isSidechain: false,
        isTrivial: true,
        lastMessage: extractTailMetadata(filepath).lastMessage,
      };
    }

    // Parse JSONL lines from the chunk
    const content = buffer.toString("utf-8", 0, bytesRead);
    const lines = content.split("\n");

    // Remove last line if it might be incomplete (no trailing newline at chunk boundary)
    if (bytesRead === maxBytes && !content.endsWith("\n")) {
      lines.pop();
    }

    const entries: ClaudeTranscriptEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const entry = JSON.parse(trimmed) as ClaudeTranscriptEntry;
        entries.push(entry);
      } catch {
        // Skip invalid JSON lines (could be truncated at chunk boundary)
        continue;
      }
    }

    // Extract parent session ID from first entry (for sub-agents)
    const firstEntry = entries[0];
    const parentSessionId = firstEntry?.sessionId;

    // Extract tail metadata (read from end of file)
    const tail = extractTailMetadata(filepath);

    // Extract the real project path from the first entry with a `cwd` field.
    // This avoids the lossy slugToPath() round-trip that breaks hyphenated paths.
    // Fall back to the tail's cwd when the head chunk is dominated by large
    // entries (e.g. base64 images) that push cwd past the 64KB read buffer.
    const projectPath = entries.find((e) => e.cwd)?.cwd ?? tail.cwd;

    const isSidechain = isSidechainSession(entries);
    const isTrivial = isTrivialSession(entries, stat.size);

    // Determine label — fall back through tail metadata when head-chunk
    // had no usable text (e.g. image exceeded buffer, or no text blocks)
    let label = extractLabel(entries);
    if (label === "No prompt") {
      label = tail.summary || tail.slug || tail.lastMessage || "No prompt";
    }

    return {
      label,
      isSidechain,
      isTrivial,
      parentSessionId,
      lastMessage: tail.lastMessage,
      lastTimestamp: tail.lastTimestamp,
      projectPath,
    };
  } catch {
    // File read error
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
 * Extract structured metadata from the tail (last maxBytes) of a JSONL file.
 * Reads in reverse to find the most recent user/assistant message, plus
 * summary and slug fields when present.
 *
 * @param filepath - Path to the JSONL file
 * @param maxBytes - Maximum bytes to read from end (default 32KB)
 * @returns TailMetadata with lastMessage, summary, and slug (all optional)
 */
export function extractTailMetadata(
  filepath: string,
  maxBytes = 32 * 1024,
): TailMetadata {
  let fd: number | null = null;

  try {
    fd = fs.openSync(filepath, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) {
      return {};
    }

    // Calculate read position (seek to end - maxBytes)
    const startPos = Math.max(0, fileSize - maxBytes);
    const bytesToRead = Math.min(fileSize, maxBytes);

    // Read the chunk
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, startPos);

    if (bytesRead === 0) {
      return {};
    }

    const content = buffer.toString("utf-8", 0, bytesRead);
    const lines = content.split("\n");

    // If we didn't read from the start, the first line might be incomplete
    if (startPos > 0) {
      lines.shift();
    }

    const result: TailMetadata = {};

    // Parse lines in reverse to find metadata (most recent first, first hit wins per field)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line) as ClaudeTranscriptEntry;

        // Extract summary from type:"summary" entries
        if (entry.type === "summary" && entry.summary && !result.summary) {
          result.summary = entry.summary;
        }

        // Extract slug (three-word session name, present on various entry types)
        if ((entry as Record<string, unknown>).slug && !result.slug) {
          result.slug = String((entry as Record<string, unknown>).slug);
        }

        // Extract lastTimestamp from any entry with a timestamp (first hit = most recent)
        if (!result.lastTimestamp && entry.timestamp) {
          result.lastTimestamp = entry.timestamp;
        }

        // Extract lastMessage from user/assistant messages with text content
        if (
          !result.lastMessage &&
          (entry.type === "user" || entry.type === "assistant") &&
          !entry.isMeta
        ) {
          const msgContent = entry.message?.content;
          let text = "";

          if (typeof msgContent === "string") {
            text = msgContent;
          } else if (Array.isArray(msgContent)) {
            // Find last text block (user messages often have system context prepended)
            for (let j = msgContent.length - 1; j >= 0; j--) {
              const block = msgContent[j];
              if (block.type === "text" && block.text) {
                text = block.text;
                break;
              }
            }
          }

          if (text) {
            // Normalize: remove newlines and trim (CSS handles truncation via ellipsis)
            result.lastMessage = text.replace(/\n/g, " ").trim();
          }
        }

        // Extract cwd (project path) from any entry with a cwd field.
        // Fallback for sessions whose head chunk is dominated by large
        // entries (e.g. base64 images) that push cwd past the 64KB read.
        if (!result.cwd && entry.cwd) {
          result.cwd = entry.cwd;
        }

        // Stop early if we've found all fields
        if (result.lastMessage && result.summary && result.slug && result.lastTimestamp && result.cwd) {
          break;
        }
      } catch {
        // Skip invalid JSON lines
        continue;
      }
    }

    return result;
  } catch {
    return {};
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
 * Extract the last message content from the end of a JSONL file.
 * @deprecated Use extractTailMetadata() instead for richer metadata.
 */
export function extractLastMessage(
  filepath: string,
  maxBytes = 32 * 1024,
): string | undefined {
  return extractTailMetadata(filepath, maxBytes).lastMessage;
}

// ============================================================================
// Agent Detection & Session Metadata
// ============================================================================

/**
 * Detect agent children from user entries.
 *
 * Looks for top-level toolUseResult.agentId on user entries to find child sessions.
 *
 * @param entries - Array of transcript entries
 * @returns Array of child session IDs (prefixed with "agent-")
 */
export function detectAgentChildren(
  entries: ClaudeTranscriptEntry[],
): string[] {
  const children: string[] = [];

  for (const entry of entries) {
    if (
      entry.type === "user" &&
      entry.toolUseResult &&
      typeof entry.toolUseResult === "object" &&
      "agentId" in entry.toolUseResult &&
      typeof entry.toolUseResult.agentId === "string"
    ) {
      const sessionId = `agent-${entry.toolUseResult.agentId}`;
      if (!children.includes(sessionId)) {
        children.push(sessionId);
      }
    }
  }

  return children;
}

/**
 * Build session metadata from parsed entries.
 *
 * @param filepath - Path to the JSONL file (for lastMessage extraction)
 * @param sessionId - Session UUID (filename without .jsonl)
 * @param entries - Parsed transcript entries
 * @param projectSlug - Project slug for this workspace
 * @param worktree - Workspace path
 * @param mtime - File modification time (ms)
 * @param size - File size in bytes
 * @returns ClaudeSessionMeta object
 */
export function buildSessionMeta(
  filepath: string,
  sessionId: string,
  entries: ClaudeTranscriptEntry[],
  projectSlug: string,
  worktree: string,
  mtime: number,
  size: number,
): ClaudeSessionMeta {
  const entryCount = entries.length;
  const now = Date.now();
  const FIVE_SECONDS = 5000;

  // Extract parentId: when forked, first user entry has parent's sessionId
  let parentId: string | undefined;
  const firstUserEntry = entries.find((e) => e.type === "user" && !e.isMeta);
  if (firstUserEntry?.sessionId && firstUserEntry.sessionId !== sessionId) {
    parentId = firstUserEntry.sessionId;
  }

  return {
    id: sessionId,
    type: sessionId.startsWith("agent-") ? "agent" : "session",
    active: now - mtime < FIVE_SECONDS,
    mtime: Math.floor(mtime / 1000), // Convert to seconds
    size,
    label: extractLabel(entries),
    toolCount: countToolUses(entries),
    messageCount: countMessages(entries),
    isSidechain: isSidechainSession(entries),
    parentId,
    children: detectAgentChildren(entries),
    projectSlug,
    worktree,
    etag: generateEtag(Math.floor(mtime / 1000), size, entryCount),
    lastMessage: extractTailMetadata(filepath).lastMessage,
  };
}

/**
 * Parse JSONL file and return file state with cache support.
 *
 * @param filepath - Path to the .jsonl file
 * @param existingState - Existing cached state (if any)
 * @returns Updated ClaudeFileReadState
 */
export function parseJsonlWithCache(
  filepath: string,
  existingState?: ClaudeFileReadState,
): ClaudeFileReadState {
  return readJsonlIncremental(filepath, existingState);
}
