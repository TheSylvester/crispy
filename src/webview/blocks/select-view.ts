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
 * - tool-panel / task-in-panel: always expanded
 * - task-tool: compact if completed, expanded if running
 * - main-thread: expanded if running or few siblings, compact if many siblings
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
  siblingCount: number,
  registry: BlocksToolRegistry,
): 'collapsed' | 'compact' | 'expanded' {
  // Panel always uses expanded
  if (anchor.type === 'tool-panel' || anchor.type === 'task-in-panel') {
    return 'expanded';
  }

  // Check if block has result
  const hasResult = block.type === 'tool_use'
    ? registry.getResult(block.id) !== undefined
    : false;

  // Inside a task tool: completed tools are compact, active tools are expanded
  if (anchor.type === 'task-tool') {
    return hasResult ? 'compact' : 'expanded';
  }

  // Main thread:
  // - Still running → expanded
  // - Few siblings → expanded (for readability)
  // - Many siblings → compact (to reduce visual noise)
  if (!hasResult) {
    return 'expanded';
  }

  // Threshold: if more than 5 tool_use blocks in same entry, use compact
  return siblingCount > 5 ? 'compact' : 'expanded';
}
