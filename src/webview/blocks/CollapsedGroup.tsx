/**
 * Collapsed Group — renders a group of collapsible tools in a <details> element
 *
 * Displays an aggregate summary in the summary row (e.g., "Read 5 files, Searched 3 patterns")
 * and renders each tool in compact view when expanded.
 *
 * @module webview/blocks/CollapsedGroup
 */

import { useMemo } from 'react';
import type { RichBlock, AnchorPoint } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import { getToolData } from './tool-definitions.js';

interface CollapsedGroupProps {
  blocks: RichBlock[];
  anchor: AnchorPoint;
  registry: BlocksToolRegistry;
}

export function CollapsedGroup({ blocks, anchor, registry }: CollapsedGroupProps): React.JSX.Element {
  // Build summary text
  const summaryText = useMemo(() => buildSummaryText(blocks), [blocks]);

  // Get tool IDs for data attribute
  const toolIds = blocks
    .filter((b): b is RichBlock & { type: 'tool_use' } => b.type === 'tool_use')
    .map((b) => b.id)
    .join(',');

  return (
    <details className="crispy-blocks-collapsed-group" data-tool-ids={toolIds}>
      <summary className="crispy-blocks-collapsed-summary">
        {summaryText}
      </summary>
      <div className="crispy-blocks-collapsed-body">
        {blocks.map((block, i) => {
          if (block.type !== 'tool_use') return null;
          return (
            <ToolBlockRenderer
              key={block.id || `block-${i}`}
              block={block}
              anchor={anchor}
              registry={registry}
              siblingCount={blocks.length}
              viewOverride="compact"
            />
          );
        })}
      </div>
    </details>
  );
}

// ============================================================================
// Summary Text Builder
// ============================================================================

/**
 * Build aggregate summary text from collapsed blocks.
 *
 * Groups by tool name and shows counts:
 * - "Read 5 files"
 * - "Read 3 files, Searched 2 patterns"
 * - "Read 5 files, Searched 2 patterns, Fetched 1 URL"
 */
function buildSummaryText(blocks: RichBlock[]): string {
  // Group by tool name
  const groups = new Map<string, RichBlock[]>();

  for (const block of blocks) {
    if (block.type !== 'tool_use') continue;
    const existing = groups.get(block.name);
    if (existing) {
      existing.push(block);
    } else {
      groups.set(block.name, [block]);
    }
  }

  // Build summary parts
  const parts: string[] = [];

  for (const [toolName, toolBlocks] of groups) {
    const data = getToolData(toolName);
    const count = toolBlocks.length;

    // Use past verb for completed actions
    const verb = data.activity.pastVerb;

    // Get subject type based on tool
    const subjectType = getSubjectType(toolName, count);

    parts.push(`${verb} ${count} ${subjectType}`);
  }

  return parts.join(', ') || 'Completed tools';
}

/**
 * Get the subject type for a tool (e.g., "files", "patterns", "URLs").
 */
function getSubjectType(toolName: string, count: number): string {
  const plural = count !== 1;

  switch (toolName) {
    case 'Read':
      return plural ? 'files' : 'file';
    case 'Glob':
      return plural ? 'patterns' : 'pattern';
    case 'Grep':
      return plural ? 'searches' : 'search';
    case 'WebFetch':
      return plural ? 'URLs' : 'URL';
    case 'WebSearch':
      return plural ? 'queries' : 'query';
    case 'TodoWrite':
      return plural ? 'updates' : 'update';
    case 'Skill':
      return plural ? 'skills' : 'skill';
    default:
      return plural ? 'items' : 'item';
  }
}
