/**
 * Block Normalization — enriches transcript entries into RichBlock[]
 *
 * Converts every entry shape (summary, string content, array content) into
 * a uniform RichBlock[] with structural context attached to each block.
 *
 * @module webview/blocks/normalize
 */

import type { TranscriptEntry, ContentBlock } from '../../core/transcript.js';
import type { BlockContext, RichBlock } from './types.js';

/**
 * Normalize a transcript entry into an array of RichBlocks.
 *
 * Rules (same as normalizeToBlocks, plus context enrichment):
 * 1. summary entry with summary text → [{ type: 'text', text: summary, context }]
 * 2. message.content is string       → [{ type: 'text', text: content, context }]
 * 3. message.content is ContentBlock[] → enrich each with context
 * 4. otherwise                        → []
 *
 * @param entry - The transcript entry to normalize
 * @param depthLookup - Optional function to look up parent tool depth
 * @returns Array of RichBlocks with context attached
 */
export function normalizeToRichBlocks(
  entry: TranscriptEntry,
  depthLookup?: (parentToolUseId: string) => number,
): RichBlock[] {
  // Compute role from entry
  const role = entry.type === 'summary'
    ? 'system'
    : (entry.message?.role ?? entry.type);

  // Extract raw blocks using the same rules as normalizeToBlocks
  const rawBlocks = extractRawBlocks(entry);
  if (rawBlocks.length === 0) return [];

  // Build the context that applies to all blocks in this entry
  const context: BlockContext = {
    entryUuid: entry.uuid ?? '',
    role,
    parentToolUseId: entry.parentToolUseID ?? undefined,
    agentId: entry.agentId ?? undefined,
    depth: computeDepth(entry.parentToolUseID, depthLookup),
    isSidechain: entry.isSidechain ?? undefined,
  };

  // Attach context to each block
  return rawBlocks.map((block) => ({ ...block, context }));
}

/**
 * Extract raw ContentBlocks from an entry.
 *
 * Handles the 4 entry shapes and applies image floating.
 */
function extractRawBlocks(entry: TranscriptEntry): ContentBlock[] {
  // Summary entries — synthesize a text block from the summary string
  if (entry.type === 'summary' && entry.summary) {
    return [{ type: 'text', text: entry.summary }];
  }

  const content = entry.message?.content;
  if (content === undefined || content === null) return [];

  // String content → wrap in a text block
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }

  // Array of content blocks — float image blocks before text blocks.
  // Claude Code sometimes places text before images in the content array,
  // but visually images should render above the accompanying message.
  // Stable sort preserves relative order within
  // each group (e.g. multiple images stay in their original sequence).
  if (content.some((b) => b.type === 'image')) {
    return [...content].sort((a, b) => {
      const ai = a.type === 'image' ? 0 : 1;
      const bi = b.type === 'image' ? 0 : 1;
      return ai - bi;
    });
  }

  return content;
}

/**
 * Compute nesting depth for blocks in this entry.
 *
 * @param parentToolUseId - The parent Task tool_use_id, if any
 * @param depthLookup - Function to get parent's depth
 * @returns Depth value (0 = root)
 */
function computeDepth(
  parentToolUseId: string | undefined,
  depthLookup?: (parentToolUseId: string) => number,
): number {
  if (!parentToolUseId || !depthLookup) {
    return 0;
  }
  return depthLookup(parentToolUseId) + 1;
}
