/**
 * Session Rendering — Pure functions for Discord message content
 *
 * Transforms transcript entries into Discord-ready string chunks (<=2000 chars).
 * No side effects, no I/O, no Discord API calls. Testable in isolation.
 *
 * Exports two render modes:
 * - `renderSession()` — flat string[] output (backwards-compatible)
 * - `renderSessionWithAnchors()` — RenderSegment[] that splits around
 *   user-authored Discord messages for deduplication
 *
 * @module message-view/render
 */

import type { TranscriptEntry } from '../transcript.js';
import type { WatchStatus } from '../session-snapshot.js';

export const DISCORD_MAX_LENGTH = 2000;

export type { WatchStatus };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RenderSegment =
  | { kind: 'content'; text: string }
  | { kind: 'discord-anchor'; messageId: string; entryIndex: number };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a session's entries into string chunks <= DISCORD_MAX_LENGTH chars.
 * Pure function: entries + toolResults in, string[] out.
 */
export function renderSession(
  entries: TranscriptEntry[],
  toolResults: Map<string, boolean>,
  statusLine?: string,
): string[] {
  const lines: string[] = [];

  if (statusLine) lines.push(statusLine);

  for (const entry of entries) {
    // Skip SDK-injected system context (local-command, task-notification, etc.)
    if (entry.isMeta) continue;

    if (entry.type === 'user') {
      const userText = extractUserText(entry);
      if (userText) lines.push(`\n**User:** ${userText}`);
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!content) continue;

    if (typeof content === 'string') {
      if (content) lines.push(content);
    } else {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          lines.push(block.text);
        }
        if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const status = toolResults.has(block.id)
            ? (toolResults.get(block.id) ? '\u{2717}' : '\u{2713}')
            : '\u{23F3}';
          lines.push(renderToolLine(block.name, input, status));
        }
      }
    }
  }

  const fullText = lines.join('\n');
  if (!fullText) return [];
  return splitAtNewlines(fullText, DISCORD_MAX_LENGTH);
}

/**
 * Content-match a user transcript entry against known Discord messages.
 * Returns the Discord message ID on match, null otherwise. Marks matched
 * IDs as consumed so duplicate user messages ("try again") don't double-match.
 */
export function findDiscordAnchor(
  entryText: string,
  userMessages: Map<string, string>,
  consumed: Set<string>,
): string | null {
  for (const [msgId, content] of userMessages) {
    if (consumed.has(msgId)) continue;
    if (content.trim() === entryText.trim()) return msgId;
    // Fuzzy: Discord may have full text, transcript may differ slightly
    if (content.startsWith(entryText.slice(0, 200))) return msgId;
  }
  return null;
}

/**
 * Render a session into RenderSegment[] that splits around user-authored
 * Discord messages (anchors). Content segments contain bot-rendered text;
 * anchor segments mark where user Discord messages live in the thread.
 */
export function renderSessionWithAnchors(
  entries: TranscriptEntry[],
  toolResults: Map<string, boolean>,
  userMessages: Map<string, string>,
  statusLine?: string,
): RenderSegment[] {
  const segments: RenderSegment[] = [];
  const consumed = new Set<string>();
  let currentContent = statusLine ? statusLine + '\n' : '';

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.isMeta) continue;

    if (entry.type === 'user') {
      const text = extractUserText(entry);
      if (!text) continue;
      const anchorId = findDiscordAnchor(text, userMessages, consumed);

      if (anchorId) {
        // Flush accumulated content
        if (currentContent.trim()) {
          for (const chunk of splitAtNewlines(currentContent, DISCORD_MAX_LENGTH)) {
            segments.push({ kind: 'content', text: chunk });
          }
          currentContent = '';
        }
        segments.push({ kind: 'discord-anchor', messageId: anchorId, entryIndex: i });
        consumed.add(anchorId);
        continue;
      }
      // No anchor — render inline as **User:** text
      currentContent += `\n**User:** ${text}`;
      continue;
    }

    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!content) continue;

    if (typeof content === 'string') {
      if (content) currentContent += '\n' + content;
    } else {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          currentContent += '\n' + block.text;
        }
        if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const status = toolResults.has(block.id)
            ? (toolResults.get(block.id) ? '\u{2717}' : '\u{2713}')
            : '\u{23F3}';
          currentContent += '\n' + renderToolLine(block.name, input, status);
        }
      }
    }
  }

  // Flush remaining
  if (currentContent.trim()) {
    for (const chunk of splitAtNewlines(currentContent, DISCORD_MAX_LENGTH)) {
      segments.push({ kind: 'content', text: chunk });
    }
  }

  return segments;
}

/** Split text into chunks <= maxLen chars, breaking at newline boundaries. */
export function splitAtNewlines(text: string, maxLen: number): string[] {
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const breakPoint = remaining.lastIndexOf('\n', maxLen);
    const splitAt = breakPoint > maxLen * 0.5 ? breakPoint : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

/** Map a WatchStatus to a Discord status line string. */
export function getStatusLine(status: WatchStatus): string {
  switch (status) {
    case 'connecting': return '\u{1F504} Connecting\u{2026}';
    case 'working': return '\u{23F3} Working\u{2026}';
    case 'idle': return '\u{2705} Done';
    case 'background': return '\u{1F504} Background';
    case 'approval': return '\u{26A0}\u{FE0F} Awaiting approval';
  }
}

/** Truncate a string, adding "..." if it exceeds max length. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

// ---------------------------------------------------------------------------
// User prompt extraction
// ---------------------------------------------------------------------------

export function extractUserText(entry: TranscriptEntry): string {
  const content = entry.message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      return block.text;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Tool line rendering
// ---------------------------------------------------------------------------

function shortPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : filePath;
}

function extractSubject(input: Record<string, unknown>): string {
  const fields = ['file_path', 'command', 'pattern', 'path', 'description', 'prompt', 'url', 'query', 'skill', 'task_id', 'name'];
  for (const field of fields) {
    const val = input[field];
    if (typeof val === 'string' && val) {
      return val.split('\n')[0].slice(0, 50);
    }
  }
  return '';
}

export function renderToolLine(name: string, input: Record<string, unknown>, status: string): string {
  switch (name.toLowerCase()) {
    case 'bash': {
      const desc = input.description as string | undefined;
      const cmd = (input.command as string ?? '').split('\n')[0].slice(0, 50);
      const subject = desc ? desc.slice(0, 50) : cmd;
      const badges: string[] = [];
      if (input.run_in_background) badges.push('[background]');
      if (input.timeout) badges.push(`[\u{23F1} ${Math.round((input.timeout as number) / 1000)}s]`);
      const meta = badges.length ? ` ${badges.join(' ')}` : '';
      return `\u{1F4BB} **bash**${meta}  \`${subject}\`  ${status}`;
    }
    case 'read': {
      const path = shortPath(input.file_path as string ?? '');
      const range = input.offset ? `:${input.offset}-${(input.offset as number) + (input.limit as number ?? 100)}` : '';
      return `\u{1F4C4} **read**  \`${path}${range}\`  ${status}`;
    }
    case 'write': {
      const path = shortPath(input.file_path as string ?? '');
      const lines = typeof input.content === 'string' ? input.content.split('\n').length : 0;
      return `\u{270E} **write**  \`${path}\` (${lines} lines)  ${status}`;
    }
    case 'edit': {
      const path = shortPath(input.file_path as string ?? '');
      const addLines = typeof input.new_string === 'string' ? input.new_string.split('\n').length : 0;
      const delLines = typeof input.old_string === 'string' ? input.old_string.split('\n').length : 0;
      return `\u{1F4DD} **edit**  \`${path}\` +${addLines} -${delLines}  ${status}`;
    }
    case 'grep': {
      const pattern = (input.pattern as string ?? '').slice(0, 40);
      const scope = input.path ?? input.glob ?? input.type ?? '';
      const scopeStr = scope ? ` in ${String(scope).slice(0, 30)}` : '';
      return `\u{1F50D} **grep**  \`${pattern}\`${scopeStr}  ${status}`;
    }
    case 'glob': {
      const pattern = (input.pattern as string ?? '').slice(0, 40);
      const scope = input.path ? ` in ${String(input.path).slice(0, 30)}` : '';
      return `\u{1F4C2} **glob**  \`${pattern}\`${scope}  ${status}`;
    }
    case 'agent': {
      const desc = (input.description as string ?? input.prompt as string ?? '').split('\n')[0].slice(0, 50);
      const badge = input.subagent_type ? ` [${input.subagent_type}]` : '';
      return `\u{1F916} **agent**${badge}  ${desc}  ${status}`;
    }
    case 'skill': {
      const skill = input.skill as string ?? '';
      return `\u{2728} **skill**  ${skill}  ${status}`;
    }
    case 'todowrite':
      return `\u{1F4CB} **todos**  updated  ${status}`;
    case 'websearch': {
      const query = (input.query as string ?? '').slice(0, 40);
      return `\u{1F310} **websearch**  \`${query}\`  ${status}`;
    }
    case 'webfetch': {
      const url = (input.url as string ?? '').slice(0, 60);
      return `\u{1F30E} **webfetch**  \`${url}\`  ${status}`;
    }
    default: {
      if (name.startsWith('mcp__')) {
        const shortName = name.replace('mcp__', '').replace(/__/g, '/');
        const subject = extractSubject(input);
        return `\u{1F50C} **${shortName}**  ${subject}  ${status}`;
      }
      const subject = extractSubject(input);
      return `\u{1F527} **${name}**  ${subject}  ${status}`;
    }
  }
}
