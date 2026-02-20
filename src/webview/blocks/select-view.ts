/**
 * Select View — anchor-based view selection for tool blocks
 *
 * Determines which view (collapsed, compact, expanded) to render
 * based on the block's anchor point, completion status, and siblings.
 *
 * @module webview/blocks/select-view
 */

import type { ToolDefinition, AnchorPoint, RichBlock } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';

/**
 * Select which view to render for a tool block.
 *
 * Rules by anchor:
 * - tool-panel / task-in-panel: compact if completed, expanded if running
 * - task-tool: compact if completed, expanded if running
 * - main-thread: always compact (expanded views live in the tool panel)
 *
 * Note: collapsed view is handled by buildRuns — blocks that reach selectView
 * are already determined to NOT be in a collapsed group.
 *
 * @param def - Tool definition with available views
 * @param anchor - Where the block is being rendered
 * @param block - The tool_use block
 * @param siblingCount - Number of sibling tool_use blocks in same entry
 * @param registry - Tool registry for checking result status
 * @returns View mode to use
 */
export function selectView(
  _def: ToolDefinition,
  anchor: AnchorPoint,
  block: RichBlock,
  _siblingCount: number,
  registry: BlocksToolRegistry,
): 'collapsed' | 'compact' | 'expanded' {
  // Check if block has result
  const hasResult = block.type === 'tool_use'
    ? registry.getResult(block.id) !== undefined
    : false;

  // Panel: compact if completed, expanded if actively running
  if (anchor.type === 'tool-panel' || anchor.type === 'task-in-panel') {
    return hasResult ? 'compact' : 'expanded';
  }

  // Inside a task tool: compact if completed, expanded if running
  if (anchor.type === 'task-tool') {
    return hasResult ? 'compact' : 'expanded';
  }

  // Main thread: always compact — expanded views live in the tool panel
  return 'compact';
}
