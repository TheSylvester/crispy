/**
 * Clipboard Serialization — converts transcript blocks to markdown for copying
 *
 * Pure functions that serialize RichBlocks into markdown strings and copy
 * them to the clipboard. No React, no side effects beyond clipboard writes.
 *
 * @module webview/utils/copy-markdown
 */

import type { RichBlock } from '../blocks/types.js';
import { extractSubject, getToolData } from '../blocks/tool-definitions.js';

// ============================================================================
// Serializers
// ============================================================================

/**
 * Serialize an assistant message's blocks to markdown.
 *
 * - Text blocks → raw markdown (already markdown-formatted)
 * - Tool use → one-liner summary: `> {icon} **{name}** \`{subject}\``
 * - Thinking blocks → skipped (too large, rarely shared)
 * - Tool results → skipped (available via per-tool copy)
 * - Images → placeholder `> [Image]`
 */
export function serializeAssistantMessage(blocks: RichBlock[]): string {
  const sections: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        sections.push(block.text);
        break;
      case 'tool_use': {
        const data = getToolData(block.name);
        const subject = extractSubject(block as RichBlock & { type: 'tool_use' });
        sections.push(`> ${data.icon} **${block.name}** \`${subject}\``);
        break;
      }
      case 'image':
        sections.push('> [Image]');
        break;
      // thinking, tool_result → skip
    }
  }

  return sections.join('\n\n');
}

/**
 * Serialize a user message's blocks to markdown.
 * Extracts only text blocks and joins them.
 */
export function serializeUserMessage(blocks: RichBlock[]): string {
  return blocks
    .filter((b): b is RichBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

// ============================================================================
// Clipboard
// ============================================================================

/**
 * Lightweight markdown → HTML conversion for rich clipboard paste.
 *
 * Handles: bold, inline code, code fences, blockquotes, line breaks.
 * Not comprehensive — just enough for readable rich-text paste.
 */
function markdownToSimpleHtml(md: string): string {
  return md
    // Code fences → <pre><code>
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
      `<pre><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`)
    // Inline code → <code>
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold → <strong>
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Blockquotes → <blockquote>
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    // Line breaks
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

/**
 * Copy markdown text to clipboard with dual-format support.
 *
 * Writes both `text/plain` (raw markdown) and `text/html` (rendered)
 * so pasting into rich editors shows formatted text, while plain text
 * editors get the raw markdown.
 *
 * Falls back to `navigator.clipboard.writeText()` when `ClipboardItem`
 * is unavailable.
 *
 * @returns true on success, false on failure
 */
export async function copyToClipboard(markdown: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined') {
      const html = markdownToSimpleHtml(markdown);
      const item = new ClipboardItem({
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      });
      await navigator.clipboard.write([item]);
    } else {
      await navigator.clipboard.writeText(markdown);
    }
    return true;
  } catch {
    return false;
  }
}
