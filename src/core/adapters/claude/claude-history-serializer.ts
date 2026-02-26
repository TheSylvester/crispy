/**
 * Claude History Serializer (Reverse Adapter)
 *
 * Converts Crispy's universal TranscriptEntry[] into Claude Code's JSONL
 * session file format. Used by the hydrated session flow to write a synthetic
 * JSONL file that the SDK can resume from.
 *
 * The forward adapter (claude-entry-adapter.ts) converts Claude JSONL →
 * TranscriptEntry; this module does the inverse.
 *
 * Does NOT handle streaming deduplication — every entry becomes one JSONL
 * line with a final stop_reason. Does NOT synthesize thinking block
 * signatures (they're stripped instead — the SDK doesn't validate them on
 * resume, and synthetic signatures would be rejected by the API anyway).
 *
 * @module claude-history-serializer
 */

import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import type {
  TranscriptEntry,
  ContentBlock,
  ThinkingBlock,
  ToolResultBlock,
} from '../../transcript.js';

// ============================================================================
// Constants
// ============================================================================

/** Hardcoded version — not validated on resume, just needs to be present. */
const SYNTHETIC_VERSION = '2.1.58';

/** Default git branch fallback. */
const DEFAULT_GIT_BRANCH = 'main';

// ============================================================================
// Path Derivation (shared with claude-code-adapter.ts discovery functions)
// ============================================================================

/**
 * Derive the Claude projects directory slug from a working directory path.
 *
 * Mirrors the path logic used by Claude Code itself:
 * `/home/silver/dev/crispy` → `-home-silver-dev-crispy`
 */
export function cwdToProjectSlug(cwd: string): string {
  return cwd.replace(/[\\/]/g, '-');
}

/**
 * Resolve the full path to a Claude project directory.
 */
function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwdToProjectSlug(cwd));
}

/**
 * Resolve the full path to a session JSONL file.
 */
function sessionFilePath(sessionId: string, cwd: string): string {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

// ============================================================================
// Content Block Filtering
// ============================================================================

/**
 * Check if a content block is a thinking block (with or without signature).
 */
function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

/**
 * Strip thinking blocks from content.
 *
 * Thinking blocks contain cryptographic signatures from Anthropic's servers
 * that cannot be synthesized. Including them would cause API errors on
 * resume, so we strip them entirely.
 */
function stripThinkingBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.filter((block) => !isThinkingBlock(block));
}

/**
 * Ensure every tool_result block has non-empty content.
 *
 * The Claude API rejects tool_result blocks with empty content — both when
 * `is_error` is true ("content cannot be empty if is_error is true") and
 * when content is missing entirely. This can happen with cross-vendor
 * entries (e.g., Codex tool calls that failed or returned no output).
 *
 * For error results: sets a fallback "(error)" message.
 * For non-error results: sets a fallback "(no output)" message.
 */
function sanitizeToolResultContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== 'tool_result') return block;

    const trb = block as ToolResultBlock;
    const c = trb.content;
    const isEmpty =
      c === '' ||
      c === undefined ||
      c === null ||
      (Array.isArray(c) && c.length === 0);

    if (!isEmpty) return block;

    return {
      ...trb,
      content: trb.is_error ? '(error)' : '(no output)',
    };
  });
}

// ============================================================================
// Entry Serialization
// ============================================================================

/**
 * Determine the stop_reason for an assistant entry.
 *
 * If the last content block is a tool_use, the stop_reason is "tool_use".
 * Otherwise it's "end_turn".
 */
function inferStopReason(content: ContentBlock[]): string {
  if (content.length === 0) return 'end_turn';
  const last = content[content.length - 1];
  return last.type === 'tool_use' ? 'tool_use' : 'end_turn';
}

/**
 * Normalize message content to a ContentBlock array.
 *
 * Handles the case where content is a plain string (wraps in text block).
 */
function normalizeContent(
  content: string | ContentBlock[] | undefined,
): ContentBlock[] {
  if (!content) return [];
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

/**
 * Check if content is purely tool_result blocks (i.e., this is a tool
 * result entry, not a user prompt).
 */
function isToolResultContent(content: ContentBlock[]): boolean {
  return content.length > 0 && content.every((b) => b.type === 'tool_result');
}

interface SerializedLine {
  [key: string]: unknown;
}

/**
 * Serialize a user-type TranscriptEntry to a Claude JSONL line object.
 */
function serializeUserEntry(
  entry: TranscriptEntry,
  uuid: string,
  parentUuid: string | null,
  sessionId: string,
  cwd: string,
  timestamp: string,
): SerializedLine {
  const content = normalizeContent(entry.message?.content);

  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId,
    timestamp,
    isSidechain: false,
    userType: 'external',
    cwd,
    version: SYNTHETIC_VERSION,
    gitBranch: DEFAULT_GIT_BRANCH,
    message: {
      role: 'user',
      content,
    },
  };
}

/**
 * Serialize an assistant-type TranscriptEntry to a Claude JSONL line object.
 */
function serializeAssistantEntry(
  entry: TranscriptEntry,
  uuid: string,
  parentUuid: string | null,
  sessionId: string,
  cwd: string,
  timestamp: string,
  index: number,
): SerializedLine {
  const rawContent = normalizeContent(entry.message?.content);
  const content = stripThinkingBlocks(rawContent);
  const stopReason = inferStopReason(content);

  return {
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId,
    timestamp,
    isSidechain: false,
    userType: 'external',
    cwd,
    version: SYNTHETIC_VERSION,
    gitBranch: DEFAULT_GIT_BRANCH,
    requestId: `req_synthetic_${String(index).padStart(3, '0')}`,
    message: {
      model: entry.message?.model ?? 'claude-opus-4-6',
      id: `msg_synthetic_${String(index).padStart(3, '0')}`,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  };
}

/**
 * Serialize a result-type TranscriptEntry as a user entry with tool_result content.
 *
 * Claude JSONL represents tool results as user entries. The `result` entry
 * type in our universal format maps to a user entry with tool_result
 * content blocks.
 */
function serializeResultEntry(
  entry: TranscriptEntry,
  uuid: string,
  parentUuid: string | null,
  sessionId: string,
  cwd: string,
  timestamp: string,
): SerializedLine {
  const raw = normalizeContent(entry.message?.content);
  const content = sanitizeToolResultContent(raw);

  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId,
    timestamp,
    isSidechain: false,
    userType: 'external',
    cwd,
    version: SYNTHETIC_VERSION,
    gitBranch: DEFAULT_GIT_BRANCH,
    message: {
      role: 'user',
      content,
    },
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Convert universal TranscriptEntry[] to Claude Code JSONL format.
 *
 * Generates valid Claude Code JSONL that the SDK can resume from.
 * Each entry becomes one JSONL line with a fresh UUID chain.
 *
 * Skips entries that can't be meaningfully serialized:
 * - system, summary, progress, queue-operation, file-history-snapshot
 * - sidechain entries (sub-agent conversations)
 * - entries with no message content
 *
 * @param entries - Universal transcript entries
 * @param sessionId - Session ID to stamp on all lines (must match filename)
 * @param cwd - Working directory for the session
 * @returns JSONL string (newline-delimited JSON objects)
 */
export function serializeToClaudeJsonl(
  entries: TranscriptEntry[],
  sessionId: string,
  cwd: string,
): string {
  if (entries.length === 0) return '';

  const lines: string[] = [];
  let prevUuid: string | null = null;
  let assistantIndex = 0;

  for (const entry of entries) {
    // Skip non-conversation entries
    if (
      entry.type !== 'user' &&
      entry.type !== 'assistant' &&
      entry.type !== 'result'
    ) {
      continue;
    }

    // Skip sidechain entries (sub-agent conversations)
    if (entry.isSidechain) continue;

    // Skip entries with no message
    if (!entry.message) continue;

    const uuid = randomUUID();
    const timestamp = entry.timestamp ?? new Date().toISOString();

    if (entry.type === 'user') {
      const content = normalizeContent(entry.message.content);

      // User entries with only tool_result blocks: serialize as tool result
      if (isToolResultContent(content)) {
        lines.push(
          JSON.stringify(
            serializeResultEntry(entry, uuid, prevUuid, sessionId, cwd, timestamp),
          ),
        );
      } else {
        lines.push(
          JSON.stringify(
            serializeUserEntry(entry, uuid, prevUuid, sessionId, cwd, timestamp),
          ),
        );
      }
    } else if (entry.type === 'assistant') {
      assistantIndex++;
      lines.push(
        JSON.stringify(
          serializeAssistantEntry(
            entry,
            uuid,
            prevUuid,
            sessionId,
            cwd,
            timestamp,
            assistantIndex,
          ),
        ),
      );
    } else if (entry.type === 'result') {
      // Result entries are tool results — serialize as user entries
      lines.push(
        JSON.stringify(
          serializeResultEntry(entry, uuid, prevUuid, sessionId, cwd, timestamp),
        ),
      );
    }

    prevUuid = uuid;
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Write a synthetic session JSONL file to disk.
 *
 * Creates the project directory if it doesn't exist and writes the JSONL
 * content to the standard Claude Code session file location.
 *
 * @param sessionId - Session UUID (used as filename)
 * @param cwd - Working directory (used to derive project slug)
 * @param jsonlContent - JSONL content string
 * @returns Absolute path to the written file
 */
export function writeSyntheticSession(
  sessionId: string,
  cwd: string,
  jsonlContent: string,
): string {
  const dir = projectDir(cwd);
  mkdirSync(dir, { recursive: true });

  const filePath = sessionFilePath(sessionId, cwd);
  writeFileSync(filePath, jsonlContent, 'utf-8');

  return filePath;
}

/**
 * Clean up a synthetic session file from disk.
 *
 * Best-effort deletion — silently ignores errors (file may already be gone,
 * or the SDK may have moved/renamed it).
 *
 * @param sessionId - Session UUID
 * @param cwd - Working directory (used to derive project slug)
 */
export function cleanupSyntheticSession(
  sessionId: string,
  cwd: string,
): void {
  try {
    unlinkSync(sessionFilePath(sessionId, cwd));
  } catch {
    // Best-effort — don't throw if file doesn't exist or is locked
  }
}
