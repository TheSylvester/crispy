/**
 * Select View — anchor-based view selection for tool blocks
 *
 * Determines which view (compact or expanded) to render based on
 * the block's anchor point and completion status.
 *
 * @module webview/blocks/select-view
 */

import type { ToolDefinition, AnchorPoint, RichBlock } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';

/**
 * Select which view to render for a tool block.
 *
 * Rules by anchor:
 * - tool-panel / task-in-panel: always expanded (collapsible via <details>)
 * - task-tool: always expanded (collapsible via <details>)
 * - main-thread: always compact (expanded views live in the tool panel)
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
  _block: RichBlock,
  _siblingCount: number,
  _registry: BlocksToolRegistry,
): 'compact' | 'expanded' {
  // Panel and nested task tools: always expanded — native <details>
  // handles collapse/expand. Completed tools render collapsed (no `open`
  // attr), running tools render expanded (`open`).
  if (anchor.type === 'tool-panel' || anchor.type === 'task-in-panel') {
    return 'expanded';
  }

  if (anchor.type === 'task-tool') {
    return 'expanded';
  }

  // Main thread: always compact — expanded views live in the tool panel
  return 'compact';
}
