/**
 * Build Runs — coalescing algorithm for blocks mode
 *
 * Groups consecutive collapsible tool_use blocks into collapsed runs.
 * A tool is collapsible if it has a collapsed view and has completed
 * without error.
 *
 * @module webview/blocks/build-runs
 */

import type { RichBlock, RenderRun } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';
import { isToolCollapsible } from './tool-definitions.js';

/**
 * Build render runs from a sequence of rich blocks.
 *
 * Rules:
 * 1. Consecutive collapsible tool_use blocks group into collapsed-group runs
 * 2. Non-collapsible blocks become single runs
 * 3. A single collapsible block becomes a single run (not a group)
 *
 * @param blocks - Normalized rich blocks from an entry
 * @param registry - Tool registry for checking completion status
 * @returns Array of render runs
 */
export function buildRuns(blocks: RichBlock[], registry: BlocksToolRegistry): RenderRun[] {
  const runs: RenderRun[] = [];
  let accumulator: RichBlock[] = [];

  for (const block of blocks) {
    if (isCollapsible(block, registry)) {
      accumulator.push(block);
    } else {
      // Flush any accumulated collapsible blocks
      if (accumulator.length > 0) {
        runs.push(flushAccumulator(accumulator));
        accumulator = [];
      }
      // Add non-collapsible block as single run
      runs.push({ type: 'single', block });
    }
  }

  // Flush remaining accumulator
  if (accumulator.length > 0) {
    runs.push(flushAccumulator(accumulator));
  }

  return runs;
}

/**
 * Flush accumulated blocks into a run.
 * Single block → single run, multiple blocks → collapsed-group run.
 */
function flushAccumulator(blocks: RichBlock[]): RenderRun {
  return blocks.length === 1
    ? { type: 'single', block: blocks[0] }
    : { type: 'collapsed-group', blocks };
}

/**
 * Check if a block is collapsible.
 *
 * A block is collapsible if:
 * 1. It's a tool_use block
 * 2. The tool has a collapsed view (collapsible: true in definition)
 * 3. The tool has completed (has a result)
 * 4. The result is not an error
 */
function isCollapsible(block: RichBlock, registry: BlocksToolRegistry): boolean {
  // Only tool_use blocks can be collapsed
  if (block.type !== 'tool_use') return false;

  // Check tool definition allows collapsing
  if (!isToolCollapsible(block.name)) return false;

  // Check completion status
  const result = registry.getResult(block.id);

  // Must have a result (completed)
  if (!result) return false;

  // Must not be an error
  if (result.is_error) return false;

  return true;
}
