/**
 * Transcript Formatter — token-efficient formatting of JSONL transcript entries
 *
 * Formats parsed Claude Code transcript entries (from jsonl-reader.ts) into
 * a human-readable, token-efficient format suitable for context windows.
 * Skips metadata entries, summarizes tool blocks, and paginates on character budget.
 *
 * @module core/recall/transcript-formatter
 */

import type { ClaudeTranscriptEntry } from '../adapters/claude/jsonl-reader.js';

// ============================================================================
// Types
// ============================================================================

/** Minimal content block shape for Claude JSONL entries. */
interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ClaudeContentBlock[];
  [key: string]: unknown;
}

export interface FormattedTranscriptOptions {
  /** Skip first N entries (0-based). Default: 0 */
  offset?: number;
  /** Return at most N entries. Default: 50 */
  limit?: number;
  /** Max output characters before truncation. Default: 30000 */
  budget?: number;
}

export interface FormattedTranscriptResult {
  content: string;
  offset: number;
  limit: number;
  totalEntries: number;
  shownEntries: number;
  truncated: boolean;
  nextOffset?: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract text content from a content block.
 * Handles text, thinking, tool_use, and tool_result blocks.
 */
function formatContentBlock(block: ClaudeContentBlock): string {
  if (typeof block === 'string') {
    return block;
  }

  const b = block as Record<string, unknown>;

  if (b.type === 'text' && typeof b.text === 'string') {
    return b.text;
  }

  if (b.type === 'thinking' && typeof b.thinking === 'string') {
    return `[Thinking: ${b.thinking.slice(0, 200)}...]`;
  }

  if (b.type === 'tool_use') {
    const name = b.name as string | undefined;
    const input = b.input as Record<string, unknown> | undefined;
    const inputStr = input ? Object.entries(input)
      .map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        return `${k}: ${val.slice(0, 60)}`;
      })
      .join(', ')
      : '';
    return `[Tool: ${name || 'unknown'}]${inputStr ? ' ' + inputStr : ''}`;
  }

  if (b.type === 'tool_result') {
    const content = b.content as string | ClaudeContentBlock[] | undefined;
    if (typeof content === 'string') {
      return `[Tool Result]\n${content.slice(0, 400)}${content.length > 400 ? '... [truncated]' : ''}`;
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter((c) => typeof c === 'object' && c !== null)
        .map((c) => (c as Record<string, unknown>).text as string | undefined)
        .filter((t) => t)
        .join(' ');
      return `[Tool Result]\n${texts.slice(0, 400)}${texts.length > 400 ? '... [truncated]' : ''}`;
    }
    return '[Tool Result] (no content)';
  }

  return '';
}

/**
 * Format all content blocks from a message into a single string.
 */
function formatMessage(message: { content: string | ClaudeContentBlock[] } | undefined): string {
  if (!message) return '';

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map(formatContentBlock)
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

/**
 * Format a single transcript entry with role + timestamp header.
 */
function formatEntry(entry: ClaudeTranscriptEntry): string | null {
  const { type, message, timestamp } = entry;

  // Skip metadata and operational entries
  if (['system', 'summary', 'custom-title', 'stream_event', 'progress', 'queue-operation', 'file-history-snapshot', 'attachment'].includes(type)) {
    return null;
  }

  // User and assistant messages have timestamps and content
  if (type === 'user' || type === 'assistant') {
    const roleLabel = type === 'user' ? 'USER' : 'ASSISTANT';
    const ts = timestamp ? new Date(timestamp).toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }) : 'unknown time';
    const content = formatMessage(message).trim();
    if (!content) return null;

    // Truncate long content
    const truncated = content.length > 2000;
    const displayContent = truncated ? content.slice(0, 2000) + '\n... [truncated]' : content;

    return `--- ${roleLabel} [${ts}] ---\n${displayContent}`;
  }

  // Result entries (tool results from user perspective)
  if (type === 'result') {
    const content = formatMessage(message).trim();
    if (!content) return null;
    return `--- RESULT [${timestamp || 'unknown time'}] ---\n${content}`;
  }

  return null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Format a list of transcript entries into token-efficient output with pagination.
 *
 * @param entries - Parsed transcript entries from parseJsonlFile()
 * @param options - Pagination and budget options
 * @returns Formatted content, metadata, and next-page info
 */
export function formatTranscript(
  entries: ClaudeTranscriptEntry[],
  options: FormattedTranscriptOptions = {},
): FormattedTranscriptResult {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const budget = options.budget ?? 30000;

  const formatted: string[] = [];
  let currentChars = 0;
  let shownCount = 0;
  let lastOffsetShown = offset - 1;

  for (let i = offset; i < entries.length && shownCount < limit; i++) {
    const formatted_entry = formatEntry(entries[i]);
    if (!formatted_entry) continue;

    const charCount = formatted_entry.length + 1; // +1 for newline
    if (currentChars + charCount > budget) {
      // Would exceed budget — stop here
      break;
    }

    formatted.push(formatted_entry);
    currentChars += charCount;
    shownCount += 1;
    lastOffsetShown = i;
  }

  const truncated = lastOffsetShown < entries.length - 1;
  const footer = truncated
    ? `\n────────────────────────────────────────\nShowing entries ${offset}–${lastOffsetShown} of ${entries.length} (~${currentChars} chars)\nNext page: offset=${lastOffsetShown + 1}`
    : `\n────────────────────────────────────────\nShowing entries ${offset}–${lastOffsetShown} of ${entries.length} (~${currentChars} chars)`;

  return {
    content: formatted.join('\n\n') + footer,
    offset,
    limit,
    totalEntries: entries.length,
    shownEntries: shownCount,
    truncated,
    nextOffset: truncated ? lastOffsetShown + 1 : undefined,
  };
}

// ============================================================================
// From indexed SQLite messages (preferred path — vendor-agnostic)
// ============================================================================

/** Shape of a message from readSessionMessages(). */
interface IndexedMessage {
  message_seq: number;
  message_id: string;
  text: string;
  role?: string;
  created_at?: number;
}

/**
 * Format a message into a display entry with role header and timestamp.
 */
function formatIndexedMessage(msg: IndexedMessage): string | null {
  const text = msg.text.trim();
  if (!text) return null;

  const role = msg.role;
  if (role !== 'user' && role !== 'human' && role !== 'assistant') return null;

  const roleLabel = role === 'assistant' ? 'ASSISTANT' : 'USER';
  const ts = msg.created_at
    ? new Date(msg.created_at).toLocaleString('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    : 'unknown time';

  const truncated = text.length > 2000;
  const display = truncated ? text.slice(0, 2000) + '\n... [truncated]' : text;

  return `--- ${roleLabel} [${ts}] ---\n${display}`;
}

/**
 * Format indexed SQLite messages into token-efficient output with pagination.
 *
 * @param messages - Messages from readSessionMessages()
 * @param options - Pagination and budget options
 * @returns Formatted content, metadata, and next-page info
 */
export function formatMessages(
  messages: IndexedMessage[],
  options: FormattedTranscriptOptions = {},
): FormattedTranscriptResult {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const budget = options.budget ?? 30000;

  const formatted: string[] = [];
  let currentChars = 0;
  let shownCount = 0;
  let lastOffsetShown = offset - 1;

  for (let i = offset; i < messages.length && shownCount < limit; i++) {
    const entry = formatIndexedMessage(messages[i]!);
    if (!entry) continue;

    const charCount = entry.length + 1;
    if (currentChars + charCount > budget) break;

    formatted.push(entry);
    currentChars += charCount;
    shownCount += 1;
    lastOffsetShown = i;
  }

  const truncated = lastOffsetShown < messages.length - 1;
  const footer = truncated
    ? `\n────────────────────────────────────────\nShowing messages ${offset}–${lastOffsetShown} of ${messages.length} (~${currentChars} chars)\nNext page: offset=${lastOffsetShown + 1}`
    : `\n────────────────────────────────────────\nShowing messages ${offset}–${lastOffsetShown} of ${messages.length} (~${currentChars} chars)`;

  return {
    content: formatted.join('\n\n') + footer,
    offset,
    limit,
    totalEntries: messages.length,
    shownEntries: shownCount,
    truncated,
    nextOffset: truncated ? lastOffsetShown + 1 : undefined,
  };
}
