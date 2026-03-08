/**
 * Oversized Session Fallback — synthetic context for sessions too large to fork
 *
 * When a transcript exceeds the fork-mode size threshold, builds a reduced
 * context from bookend turns (first/last from the JSONL) plus any existing
 * rosie-meta summaries from the DB for the middle. Dispatched with forceNew
 * instead of fork so the model reads a text description rather than the
 * actual (too-large) transcript.
 *
 * @module rosie/oversized-fallback
 */

import { statSync, readFileSync } from 'node:fs';
import { getDb } from '../crispy-db.js';
import { dbPath } from '../activity-index.js';
import { SUMMARIZE_PROMPT } from './summarize-hook.js';

// ============================================================================
// Constants
// ============================================================================

/** Conservative file-size threshold for fork mode. 2.1MB worked, 2.6MB didn't — use 2MB. */
export const MAX_FORK_FILE_SIZE = 2 * 1024 * 1024; // 2MB

const MAX_TURN_CHARS = 4000;

// ============================================================================
// Types
// ============================================================================

export interface RosieMetaEntry {
  timestamp: string;
  quest: string;
  title: string;
  summary: string;
  status: string;
}

export interface BookendTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ============================================================================
// Functions
// ============================================================================

/** Check whether a transcript file exceeds the fork-mode size threshold. */
export function isOversized(filePath: string): boolean {
  try {
    return statSync(filePath).size > MAX_FORK_FILE_SIZE;
  } catch {
    return false;
  }
}

/** Fetch existing rosie-meta entries for a session file, ordered chronologically. */
export function getExistingRosieMetas(file: string): RosieMetaEntry[] {
  const db = getDb(dbPath());
  const rows = db.all(`
    SELECT timestamp, quest, title, summary, status
    FROM activity_entries
    WHERE kind = 'rosie-meta' AND file = ?
    ORDER BY timestamp ASC
  `, [file]) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    timestamp: (r.timestamp as string) ?? '',
    quest: (r.quest as string) ?? '',
    title: (r.title as string) ?? '',
    summary: (r.summary as string) ?? '',
    status: (r.status as string) ?? '',
  }));
}

/**
 * Extract the first N and last M user/assistant turns from a JSONL transcript.
 * Gives the model the conversation's opening (original ask) and ending (final state).
 */
export function extractBookendTurns(
  filePath: string,
  firstN: number = 2,
  lastM: number = 2,
): { first: BookendTurn[]; last: BookendTurn[] } {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);

  const entries: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  // Filter to user/assistant message entries (skip system, meta, tool results, etc.)
  const messageTurns = entries.filter(
    (e) => (e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.toolUseResult,
  );

  const first = messageTurns.slice(0, firstN).map(summarizeTurn);
  const last = messageTurns.length > firstN
    ? messageTurns.slice(-lastM).map(summarizeTurn)
    : [];
  return { first, last };
}

function summarizeTurn(entry: Record<string, unknown>): BookendTurn {
  const role = entry.type === 'user' ? 'user' as const : 'assistant' as const;
  let content = '';

  const msg = entry.message as { content?: unknown } | undefined;
  if (typeof msg?.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg?.content)) {
    content = (msg.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n');
  }

  if (content.length > MAX_TURN_CHARS) {
    content = content.slice(0, MAX_TURN_CHARS) + '\n[...truncated]';
  }
  return { role, content };
}

/** Assemble synthetic context + summarize prompt for oversized sessions. */
export function buildFallbackPrompt(
  firstTurns: BookendTurn[],
  lastTurns: BookendTurn[],
  metas: RosieMetaEntry[],
): string {
  let context = 'You are summarizing a conversation that was too long to show in full.\n\n';

  context += '## Opening turns (verbatim)\n\n';
  for (const t of firstTurns) {
    context += `**${t.role}:** ${t.content}\n\n`;
  }

  if (metas.length > 0) {
    context += '## Intermediate turn summaries (from prior analysis)\n\n';
    for (const m of metas) {
      context += `- **${m.title}** — ${m.quest}\n  Status: ${m.status}\n\n`;
    }
  } else {
    context += '## Middle turns\n\n[No prior summaries available — middle of conversation omitted]\n\n';
  }

  context += '## Final turns (verbatim)\n\n';
  for (const t of lastTurns) {
    context += `**${t.role}:** ${t.content}\n\n`;
  }

  context += '---\n\nBased on the conversation above, produce the following analysis:\n\n';
  context += SUMMARIZE_PROMPT;

  return context;
}
