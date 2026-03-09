/**
 * Select View — anchor-based view selection for tool blocks
 *
 * Determines which view (compact, expanded, or inline) to render based on
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
 * - main-thread: compact by default, inline when inlineMode is on and
 *   the tool has an inline view registered
 *
 * @param def - Tool definition with available views
 * @param anchor - Where the block is being rendered
 * @param block - The tool_use block
 * @param siblingCount - Number of sibling tool_use blocks in same entry
 * @param registry - Tool registry for checking result status
 * @param inlineMode - Whether inline tool mode is enabled
 * @returns View mode to use
 */
export function selectView(
  def: ToolDefinition,
  anchor: AnchorPoint,
  _block: RichBlock,
  _siblingCount: number,
  _registry: BlocksToolRegistry,
  inlineMode = false,
  condensedMode = false,
): 'compact' | 'condensed' | 'expanded' | 'inline' {
  // Panel and nested task tools: always expanded — native <details>
  // handles collapse/expand. Completed tools render collapsed (no `open`
  // attr), running tools render expanded (`open`).
  if (anchor.type === 'tool-panel' || anchor.type === 'task-in-panel') {
    return 'expanded';
  }

  if (anchor.type === 'task-tool') {
    return 'expanded';
  }

  // Main thread with inline mode: use inline if the tool has an inline view
  if (anchor.type === 'main-thread' && inlineMode && def.views.inline) {
    return 'inline';
  }

  // Main thread with condensed mode: use condensed (dot-line) if available
  if (anchor.type === 'main-thread' && condensedMode && def.views.condensed) {
    return 'condensed';
  }

  // Main thread: always compact — expanded views live in the tool panel
  return 'compact';
}
