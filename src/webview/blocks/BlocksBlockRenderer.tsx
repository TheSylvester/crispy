/**
 * Blocks Block Renderer — dispatches a single RichBlock to the appropriate renderer
 *
 * Handles non-tool block types:
 * - text + user role → UserTextRenderer
 * - text + assistant role → AssistantTextRenderer
 * - thinking → ThinkingRenderer
 * - image → ImageRenderer
 * - default → YAML dump
 *
 * tool_use and tool_result blocks are handled by the parent entry component
 * via ToolBlockRenderer and ToolResultRenderer respectively — they should
 * not reach this component.
 *
 * @module webview/blocks/BlocksBlockRenderer
 */

import type { RichBlock } from './types.js';
import { AssistantTextRenderer } from '../renderers/AssistantTextRenderer.js';
import { UserTextRenderer } from '../renderers/UserTextRenderer.js';
import { ImageRenderer } from '../renderers/ImageRenderer.js';

export interface BlocksBlockRendererProps {
  block: RichBlock;
}

/**
 * Renders a non-tool block (text, thinking, image, unknown).
 *
 * tool_use and tool_result blocks are handled directly by the parent entry
 * component via ToolBlockRenderer and ToolResultRenderer — they should not
 * reach this component.
 */
export function BlocksBlockRenderer({
  block,
}: BlocksBlockRendererProps): React.JSX.Element | null {
  switch (block.type) {
    case 'text':
      if (block.context.role === 'user') {
        return <UserTextRenderer block={block} />;
      }
      return <AssistantTextRenderer block={block} />;

    case 'thinking':
      return <ThinkingRenderer block={block} />;

    case 'image':
      return <ImageRenderer block={block} />;

    default:
      // Unknown block type — render as YAML
      return <UnknownBlockView block={block} />;
  }
}

// ============================================================================
// Thinking Renderer — collapsible thinking display
// ============================================================================

function ThinkingRenderer({ block }: { block: RichBlock }): React.JSX.Element {
  const thinkingBlock = block as RichBlock & { thinking: string; isSummary?: boolean };
  const content = thinkingBlock.thinking ?? '';
  const isSummary = thinkingBlock.isSummary ?? false;

  return (
    <details className="crispy-blocks-thinking" open={!isSummary}>
      <summary className="crispy-blocks-thinking-summary">
        {isSummary ? 'Thinking (summarized)' : 'Thinking'}
      </summary>
      <pre className="crispy-blocks-thinking-content">{content}</pre>
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
