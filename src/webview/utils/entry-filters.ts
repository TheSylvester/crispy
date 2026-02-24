/**
 * Entry filtering — determines which transcript entries are rendered
 *
 * Single filter function used by all render modes. Pure function with
 * no side effects. Ported from Leto's `webview-next/renderer/entry.ts`
 * shouldRenderEntry().
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
 * - Nested entries (parentToolUseID — sub-agent children render inside
 *   their parent Task card, not as top-level messages)
 * - Entries with no message (and not a summary)
 *
 * Tool-result user entries (toolUseResult) are NOT filtered — they must
 * render so ToolResultRenderer mounts and reports results to the registry.
 * BlocksEntry returns null for entries containing only tool_result blocks,
 * so they produce no visible DOM.
 *
 * Summary entries are allowed through if they have summary text,
 * even without a message field.
 */
export function shouldRenderEntry(entry: TranscriptEntry): boolean {
  if (SKIP_ENTRY_TYPES.has(entry.type)) return false;

  // Sub-agent entries render inside their parent Task tool card via the
  // ToolRegistry's parent-child tree — not as top-level messages.
  // The adapter unwraps 'progress' entries to expose their content, changing
  // their type to 'assistant'/'user', so we must filter on parentToolUseID.
  if (entry.parentToolUseID) return false;

  // Summary entries use entry.summary, not entry.message — let them through
  if (entry.type === 'summary' && entry.summary) return true;

  if (!entry.message) return false;

  return true;
}
