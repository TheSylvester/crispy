/**
 * Blocks Block Renderer — dispatches a single RichBlock to the appropriate renderer
 *
 * Handles all block types:
 * - tool_result → null (teleportation to tool_use card)
 * - tool_use → ToolBlockRenderer
 * - text + user role → UserTextRenderer
 * - text + assistant role → AssistantTextRenderer
 * - thinking → ThinkingView
 * - image → ImageRenderer
 * - default → YAML dump
 *
 * @module webview/blocks/BlocksBlockRenderer
 */

import { useRef, useEffect } from 'react';
import type { RichBlock } from './types.js';
import { AssistantTextRenderer } from '../renderers/AssistantTextRenderer.js';
import { UserTextRenderer } from '../renderers/UserTextRenderer.js';
import { ImageRenderer } from '../renderers/ImageRenderer.js';

export interface BlocksBlockRendererProps {
  block: RichBlock;
  /** When true, thinking blocks auto-collapse (one-shot, user can re-expand) */
  autoCollapse?: boolean;
}

/**
 * Renders a non-tool block (text, thinking, image, tool_result, unknown).
 *
 * tool_use blocks are handled directly by the parent entry component via
 * ToolBlockRenderer — they should not reach this component.
 */
export function BlocksBlockRenderer({
  block,
  autoCollapse,
}: BlocksBlockRendererProps): React.JSX.Element | null {
  switch (block.type) {
    case 'tool_result':
      // Tool results are rendered on their tool_use card via registry
      // Return null here (teleportation pattern)
      return null;

    case 'tool_use':
      // tool_use blocks are handled by the parent entry component
      // via ToolBlockRenderer directly — should not reach here.
      return null;

    case 'text':
      if (block.context.role === 'user') {
        return <UserTextRenderer block={block} />;
      }
      return <AssistantTextRenderer block={block} />;

    case 'thinking':
      return <ThinkingView block={block} autoCollapse={autoCollapse} />;

    case 'image':
      return <ImageRenderer block={block} />;

    default:
      // Unknown block type — render as YAML
      return <UnknownBlockView block={block} />;
  }
}

// ============================================================================
// Thinking View — collapsible thinking display
// ============================================================================

function ThinkingView({ block, autoCollapse }: { block: RichBlock; autoCollapse?: boolean }): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const hasAutoCollapsed = useRef(false);

  const thinkingBlock = block as RichBlock & { thinking: string; isSummary?: boolean };
  const content = thinkingBlock.thinking ?? '';
  const isSummary = thinkingBlock.isSummary ?? false;

  // Start collapsed if summary or auto-collapse is requested
  const defaultOpen = !isSummary && !autoCollapse;

  // One-shot collapse: when autoCollapse flips true after initial render,
  // programmatically close via ref. After this, browser manages toggle state
  // so user can re-expand freely.
  useEffect(() => {
    if (autoCollapse && !hasAutoCollapsed.current && detailsRef.current) {
      detailsRef.current.open = false;
      hasAutoCollapsed.current = true;
    }
  }, [autoCollapse]);

  const preview = content.length > 0
    ? content.replace(/\s+/g, ' ').trim().slice(0, 120) + (content.length > 120 ? '…' : '')
    : '';

  return (
    <details ref={detailsRef} className="crispy-blocks-thinking" open={defaultOpen}>
      <summary className="crispy-blocks-thinking-summary">
        {preview || 'Thinking'}
      </summary>
      <pre
        className="crispy-blocks-thinking-content"
        onClick={() => { if (detailsRef.current) detailsRef.current.open = false; }}
      >{content || 'Thinking'}</pre>
    </details>
  );
}

// ============================================================================
// Unknown Block View — YAML fallback
// ============================================================================

function UnknownBlockView({ block }: { block: RichBlock }): React.JSX.Element {
  return (
    <div className="crispy-blocks-unknown">
      <pre className="crispy-blocks-unknown-content">
        {JSON.stringify(block, null, 2)}
      </pre>
    </div>
  );
}
