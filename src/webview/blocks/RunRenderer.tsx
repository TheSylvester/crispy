/**
 * Run Renderer — renders a single RenderRun (single block or collapsed group)
 *
 * Dispatches to either BlocksBlockRenderer for single blocks or
 * CollapsedGroup for collapsed groups.
 *
 * @module webview/blocks/RunRenderer
 */

import type { RenderRun, AnchorPoint } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';
import { BlocksBlockRenderer } from './BlocksBlockRenderer.js';
import { CollapsedGroup } from './CollapsedGroup.js';

interface RunRendererProps {
  run: RenderRun;
  anchor: AnchorPoint;
  registry: BlocksToolRegistry;
  /** Total sibling count for view selection */
  siblingCount: number;
}

export function RunRenderer({ run, anchor, registry, siblingCount }: RunRendererProps): React.JSX.Element | null {
  switch (run.type) {
    case 'single': {
      // Wrap tool_use blocks with data-run-id for visibility tracking
      const runId = run.block.type === 'tool_use' ? run.block.id : undefined;
      const inner = (
        <BlocksBlockRenderer
          block={run.block}
          anchor={anchor}
          registry={registry}
          siblingCount={siblingCount}
        />
      );
      return runId
        ? <div data-run-id={runId}>{inner}</div>
        : inner;
    }

    case 'collapsed-group':
      return (
        <CollapsedGroup
          blocks={run.blocks}
          anchor={anchor}
          registry={registry}
        />
      );

    default:
      return null;
  }
}

/**
 * Generate a stable key for a render run.
 */
export function runKey(run: RenderRun, index: number): string {
  if (run.type === 'single') {
    const block = run.block;
    if (block.type === 'tool_use') return `tool-${block.id}`;
    return `block-${block.context.entryUuid}-${index}`;
  }

  // For collapsed groups, use first block's ID
  const firstBlock = run.blocks[0];
  if (firstBlock?.type === 'tool_use') {
    return `group-${firstBlock.id}`;
  }
  return `group-${index}`;
}
