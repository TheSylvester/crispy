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
}

/** Structured metadata extracted from the tail (last 32KB) of a JSONL file. */
export interface TailMetadata {
  lastMessage?: string; // last user/assistant text
  summary?: string; // from type:"summary" entry (AI-generated title)
  slug?: string; // three-word session name from any entry
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
          console.warn(`[jsonl-reader] Skipping unparseable line: ${(err as Error).message}`);
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
        console.warn(`[jsonl-reader] Skipping unparseable line: ${(err as Error).message}`);
        continue;
      }
    }

    return entries;
  } catch (error) {
    console.error(`Failed to read JSONL file ${filepath}:`, error);
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

    // Extract the real project path from the first entry with a `cwd` field.
    // This avoids the lossy slugToPath() round-trip that breaks hyphenated paths.
    const projectPath = entries.find((e) => e.cwd)?.cwd;

    // Extract tail metadata (read from end of file)
    const tail = extractTailMetadata(filepath);

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

        // Stop early if we've found all fields
        if (result.lastMessage && result.summary && result.slug) {
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
