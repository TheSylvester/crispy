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

import type { RichBlock, AnchorPoint } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import { AssistantTextRenderer } from '../renderers/AssistantTextRenderer.js';
import { UserTextRenderer } from '../renderers/UserTextRenderer.js';
import { ImageRenderer } from '../renderers/ImageRenderer.js';

interface BlocksBlockRendererProps {
  block: RichBlock;
  anchor: AnchorPoint;
  registry: BlocksToolRegistry;
  /** Number of sibling tool_use blocks in same entry */
  siblingCount: number;
}

export function BlocksBlockRenderer({
  block,
  anchor,
  registry,
  siblingCount,
}: BlocksBlockRendererProps): React.JSX.Element | null {
  switch (block.type) {
    case 'tool_result':
      // Tool results are rendered on their tool_use card via registry
      // Return null here (teleportation pattern)
      return null;

    case 'tool_use':
      return (
        <ToolBlockRenderer
          block={block}
          anchor={anchor}
          registry={registry}
          siblingCount={siblingCount}
        />
      );

    case 'text':
      if (block.context.role === 'user') {
        return <UserTextRenderer block={block} />;
      }
      return <AssistantTextRenderer block={block} />;

    case 'thinking':
      return <ThinkingView block={block} />;

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

function ThinkingView({ block }: { block: RichBlock }): React.JSX.Element {
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
