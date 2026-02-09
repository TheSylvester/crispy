/**
 * Entry filtering — determines which transcript entries are rendered
 *
 * Pure function with no side effects. Ported from Leto's
 * `webview-next/renderer/entry.ts` shouldRenderEntry().
 *
 * @module webview/utils/entry-filters
 */

import type { TranscriptEntry } from '../../core/transcript.js';

/** Entry types that are internal bookkeeping — never rendered */
const SKIP_ENTRY_TYPES = new Set([
  'queue-operation',
  'file-history-snapshot',
  'result',           // tool_result blocks reach UI via pairing, not entry rendering
  'stream_event',
  'progress',         // internal progress events, not user-facing
]);

/**
 * Check if an entry should be rendered at the top level.
 *
 * Filters out:
 * - Internal entry types (result, stream_event, progress, etc.)
 * - Entries with no message (and not a summary)
 * - Subagent user messages (user entries with parentUuid — they render
 *   inside their parent Task card, not at top level)
 *
 * Summary entries are allowed through if they have summary text,
 * even without a message field.
 */
export function shouldRenderEntry(entry: TranscriptEntry): boolean {
  if (SKIP_ENTRY_TYPES.has(entry.type)) return false;

  // Summary entries use entry.summary, not entry.message — let them through
  if (entry.type === 'summary' && entry.summary) return true;

  if (!entry.message) return false;

  // Subagent user messages render inside their parent Task card, not at top level
  if (entry.type === 'user' && entry.parentUuid) return false;

  return true;
}
