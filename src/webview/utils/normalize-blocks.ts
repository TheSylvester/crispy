/**
 * Block Normalization — projects every entry shape into uniform ContentBlock[]
 *
 * Eliminates the 3-path branching (summary / string / array) that previously
 * lived inline in RichEntry. Every entry becomes the same shape before any
 * renderer sees it.
 *
 * @module webview/utils/normalize-blocks
 */

import type { TranscriptEntry, ContentBlock } from '../../core/transcript.js';

/**
 * Normalize a transcript entry into a flat array of content blocks.
 *
 * Rules:
 * 1. summary entry with summary text → [{ type: 'text', text: summary }]
 * 2. message.content is string       → [{ type: 'text', text: content }]
 * 3. message.content is ContentBlock[] → return as-is
 * 4. otherwise                        → []
 */
export function normalizeToBlocks(entry: TranscriptEntry): ContentBlock[] {
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
  // but visually images should render above the accompanying message
  // (matching Leto's layout). Stable sort preserves relative order within
  // each group (e.g. multiple images stay in their original sequence).
  if (content.some(b => b.type === 'image')) {
    return [...content].sort((a, b) => {
      const ai = a.type === 'image' ? 0 : 1;
      const bi = b.type === 'image' ? 0 : 1;
      return ai - bi;
    });
  }
  return content;
}
