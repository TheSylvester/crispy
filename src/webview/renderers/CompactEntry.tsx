/**
 * Compact Entry Renderer — single-line summaries for quick scanning
 *
 * Shows [role] prefix + truncated text + [tools: ...] summary.
 * Ported from Leto's `webview-next/renderer/compact-renderer.ts`,
 * adapted from HTML string returns to React JSX.
 *
 * @module webview/renderers/CompactEntry
 */

import type {
  TranscriptEntry,
  ContentBlock,
  ToolUseBlock,
} from '../../core/transcript.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum characters to display before truncating */
const MAX_CONTENT_LENGTH = 200;

/** Maximum characters for thinking preview */
const MAX_THINKING_LENGTH = 100;

// ============================================================================
// Content Extraction Helpers
// ============================================================================

/** Extract text content from message content (string or block array) */
function extractTextContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && 'text' in block
    )
    .map((block) => block.text)
    .join('\n');
}

/** Extract thinking content from block arrays */
function extractThinkingContent(content: string | ContentBlock[] | undefined): string {
  if (!content || typeof content === 'string') return '';
  return content
    .filter((block): block is { type: 'thinking'; thinking: string } =>
      block.type === 'thinking' && 'thinking' in block
    )
    .map((block) => block.thinking)
    .join('\n');
}

/** Extract tool_use blocks from block arrays */
function extractToolUseBlocks(content: string | ContentBlock[] | undefined): ToolUseBlock[] {
  if (!content || typeof content === 'string') return [];
  return content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}

/** Count image blocks in content */
function extractImageCount(content: string | ContentBlock[] | undefined): number {
  if (!content || typeof content === 'string') return 0;
  return content.filter(block => block.type === 'image').length;
}

/** Truncate text to max length with ellipsis */
function truncate(text: string, maxLength: number = MAX_CONTENT_LENGTH): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength) + '...';
}

// ============================================================================
// Tool Summary
// ============================================================================

/** Renders a compact [tools: Bash, Read, Edit] summary */
function ToolSummary({ blocks }: { blocks: ToolUseBlock[] }): React.JSX.Element | null {
  if (blocks.length === 0) return null;

  const toolNames = blocks
    .map((b) => b.name || 'tool')
    .slice(0, 3);

  let summary = toolNames.join(', ');
  if (blocks.length > 3) {
    summary += ` +${blocks.length - 3} more`;
  }

  return <span className="compact-tools-summary">[tools: {summary}]</span>;
}

// ============================================================================
// Compact Entry Component
// ============================================================================

interface CompactEntryProps {
  entry: TranscriptEntry;
}

/**
 * Renders a transcript entry as a single compact line.
 *
 * Skips system and result type entries independently of shouldRenderEntry
 * (belt and suspenders). Shows:
 * - [role] prefix + truncated text
 * - [thinking] prefix for thinking-only entries
 * - [tools: Bash, Read] summary appended or as main content
 */
export function CompactEntry({ entry }: CompactEntryProps): React.JSX.Element | null {
  const role = entry.message?.role ?? entry.type;

  // Skip system and result messages in compact mode
  if (entry.type === 'system' || entry.type === 'result') {
    return null;
  }

  // Summary entries
  if (entry.type === 'summary' && entry.summary) {
    return (
      <div className="message system compact-entry" data-uuid={entry.uuid}>
        <span className="compact-role">[summary]</span> {truncate(entry.summary)}
      </div>
    );
  }

  if (!entry.message) return null;

  const content = entry.message.content;
  const textContent = extractTextContent(content);
  const thinkingContent = extractThinkingContent(content);
  const toolBlocks = extractToolUseBlocks(content);
  const imageCount = extractImageCount(content);

  // Skip if no meaningful content
  if (!textContent && !thinkingContent && toolBlocks.length === 0 && imageCount === 0) {
    return null;
  }

  const rolePrefix = `[${role}]`;

  const imageBadge = imageCount > 0
    ? <span className="compact-tools-summary">[{imageCount === 1 ? '1 image' : `${imageCount} images`}]</span>
    : null;

  return (
    <div className={`message ${role} compact-entry`} data-uuid={entry.uuid}>
      {textContent ? (
        <>
          <span className="compact-role">{rolePrefix}</span>{' '}
          {truncate(textContent)}
          {toolBlocks.length > 0 && (
            <>{' '}<ToolSummary blocks={toolBlocks} /></>
          )}
          {imageBadge && <>{' '}{imageBadge}</>}
        </>
      ) : thinkingContent ? (
        <>
          <span className="compact-role">[thinking]</span>{' '}
          {truncate(thinkingContent, MAX_THINKING_LENGTH)}
        </>
      ) : toolBlocks.length > 0 ? (
        <>
          <span className="compact-role">{rolePrefix}</span>{' '}
          <ToolSummary blocks={toolBlocks} />
          {imageBadge && <>{' '}{imageBadge}</>}
        </>
      ) : imageBadge ? (
        <>
          <span className="compact-role">{rolePrefix}</span>{' '}
          {imageBadge}
        </>
      ) : null}
    </div>
  );
}
