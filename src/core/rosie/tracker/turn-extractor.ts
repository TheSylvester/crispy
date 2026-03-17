/**
 * Turn Extractor — vendor-agnostic turn extraction
 *
 * Two extraction paths:
 *   1. extractTurnsFromMessages() — from the messages table (paginated,
 *      text-only, no JSONL parsing). Preferred for the RPC.
 *   2. extractTurns() — from TranscriptEntry[] (full structured entries).
 *      Used when entries are already in memory.
 *
 * @module rosie/tracker/turn-extractor
 */

import type { TranscriptEntry, ContentBlock } from '../../transcript.js';

// ============================================================================
// Types
// ============================================================================

export interface SessionTurn {
  /** 1-indexed turn number */
  turn: number;
  /** The user's text message */
  user: string;
  /** The assistant's text response */
  assistant: string;
}

/** Shape of a message row from readSessionMessages(). */
export interface FlatMessage {
  message_seq: number;
  text: string;
  role?: string;
}

// ============================================================================
// From messages table (preferred — paginated, no JSONL)
// ============================================================================

/**
 * Extract user/assistant turns from flat message rows.
 *
 * Each turn starts at a user/human message and collects all subsequent
 * assistant messages until the next user message.
 */
export function extractTurnsFromMessages(messages: FlatMessage[]): SessionTurn[] {
  const turns: SessionTurn[] = [];

  // Find user message indices
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]!.role;
    if (role === 'user' || role === 'human') {
      const text = messages[i]!.text.trim();
      if (text) userIndices.push(i);
    }
  }

  for (let u = 0; u < userIndices.length; u++) {
    const userIdx = userIndices[u]!;
    const nextUserIdx = u + 1 < userIndices.length ? userIndices[u + 1]! : messages.length;

    const userText = messages[userIdx]!.text;

    let assistantText = '';
    for (let j = userIdx + 1; j < nextUserIdx; j++) {
      const msg = messages[j]!;
      if (msg.role === 'assistant') {
        if (assistantText) assistantText += '\n';
        assistantText += msg.text;
      }
    }

    turns.push({
      turn: u + 1,
      user: userText,
      assistant: assistantText.trim(),
    });
  }

  return turns;
}

// ============================================================================
// From TranscriptEntry[] (when entries are already loaded)
// ============================================================================

/**
 * Extract all user/assistant turns from a normalized TranscriptEntry[].
 *
 * Each turn starts at a user entry with real text (not a tool_result
 * continuation or meta entry) and includes all subsequent assistant
 * entries until the next user entry.
 */
export function extractTurns(entries: TranscriptEntry[]): SessionTurn[] {
  const turns: SessionTurn[] = [];

  const userIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type === 'user' && !e.isMeta && extractEntryText(e) !== null) {
      userIndices.push(i);
    }
  }

  for (let u = 0; u < userIndices.length; u++) {
    const userIdx = userIndices[u]!;
    const nextUserIdx = u + 1 < userIndices.length ? userIndices[u + 1]! : entries.length;

    const userEntry = entries[userIdx]!;
    const userText = extractEntryText(userEntry)!;

    let assistantText = '';

    for (let j = userIdx + 1; j < nextUserIdx; j++) {
      const entry = entries[j]!;
      if (entry.type === 'assistant' && entry.message) {
        const content = entry.message.content;
        if (typeof content === 'string') {
          assistantText += content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              assistantText += (block as { text: string }).text;
            }
          }
        }
      }
    }

    turns.push({
      turn: u + 1,
      user: userText,
      assistant: assistantText.trim(),
    });
  }

  return turns;
}

/**
 * Extract a single turn (the latest) from entries.
 * Used by the live tracker which only needs the most recent turn.
 */
export function extractLatestTurn(entries: TranscriptEntry[]): SessionTurn | null {
  const turns = extractTurns(entries);
  return turns.length > 0 ? turns[turns.length - 1]! : null;
}

/**
 * Format a turn as the tracker injection text.
 *
 * Output:
 *   user: <text>
 *   assistant: <text>
 *
 * Tool calls are omitted — the assistant text already describes
 * what was accomplished. Tool calls are implementation details
 * that waste tokens without adding tracking signal.
 */
export function formatTurnContent(turn: SessionTurn): string {
  let result = `user: ${turn.user}`;

  if (turn.assistant) {
    result += `\nassistant: ${turn.assistant}`;
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

/** Extract plain text from a transcript entry. */
function extractEntryText(entry: TranscriptEntry): string | null {
  if (!entry.message) return null;
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = (content as ContentBlock[])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}
