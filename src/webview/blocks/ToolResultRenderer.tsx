/**
 * ToolResultRenderer -- reports tool results to the registry
 *
 * Mounts inline where tool_result blocks appear in the entry's block list.
 * Reports its result to the registry on mount via useEffect. Renders null
 * to DOM -- its purpose is signal delivery, not visual rendering. The registry
 * notifies the paired ToolBlockRenderer which re-renders with the result
 * inside its card.
 *
 * Does NOT handle:
 * - Nested content walking (walkNestedForRegistry) -- that stays in the
 *   preprocessing pass since nested blocks don't have their own renderers
 * - Async agent detection -- also stays in preprocessing
 * - Child entries grouping -- separate concern, stays in preprocessing
 *
 * @module webview/blocks/ToolResultRenderer
 */

import { useEffect } from 'react';
import type { RichBlock } from './types.js';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';

interface ToolResultRendererProps {
  block: RichBlock & { type: 'tool_result'; tool_use_id: string };
}

export function ToolResultRenderer({ block }: ToolResultRendererProps): null {
  const registry = useBlocksToolRegistry();

  useEffect(() => {
    registry.resolve(block.tool_use_id, block);
  }, [block, registry]);

  return null;
}
