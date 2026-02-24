/**
 * CollapsedTurnSummary -- aggregated summary row for ephemeral tools in a completed turn
 *
 * Renders a single compact row showing tool type icons and counts for
 * read-only/ephemeral tools (Read, Grep, Glob, etc.). Expands on click
 * to show individual compact rows.
 *
 * Does NOT handle:
 * - Outcome tools (Bash, Edit, Write, etc.) -- those render as normal compact rows
 * - Streaming turns -- caller is responsible for not rendering this during streaming
 * - Panel rendering -- only used in main-thread transcript view
 *
 * @module webview/blocks/CollapsedTurnSummary
 */

import { useState, useCallback } from 'react';
import type { RichBlock, AnchorPoint } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import { getToolData } from './tool-definitions.js';

// ============================================================================
// Ephemeral Tool Classification
// ============================================================================

/**
 * Tools whose invocations are ephemeral/read-only and should collapse
 * into the summary row. These don't produce lasting side-effects.
 */
const EPHEMERAL_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'LS',
  'ReadMcpResource',
  'ListMcpResources',
]);

/**
 * Test whether a tool name is ephemeral (read-only / informational).
 *
 * Known ephemeral tools match by exact name. MCP tools with read-like
 * verbs in their name (read, get, list, search, find, fetch) also qualify.
 */
export function isEphemeralTool(toolName: string): boolean {
  if (EPHEMERAL_TOOLS.has(toolName)) return true;
  // MCP tools with read-like verbs
  if (toolName.startsWith('mcp__') && /\b(read|get|list|search|find|fetch)\b/i.test(toolName)) {
    return true;
  }
  return false;
}

// ============================================================================
// Component
// ============================================================================

interface CollapsedTurnSummaryProps {
  /** Ephemeral tool_use blocks to summarize */
  blocks: (RichBlock & { type: 'tool_use' })[];
  /** Tool registry for result lookups */
  registry: BlocksToolRegistry;
  /** Sibling count for view selection (total tool_use count in entry) */
  siblingCount: number;
  /** Anchor point for child renderers when expanded */
  anchor: AnchorPoint;
}

/** Group consecutive tools by name, preserving order of first appearance. */
function groupByToolName(blocks: (RichBlock & { type: 'tool_use' })[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
  }
  return counts;
}

export function CollapsedTurnSummary({
  blocks,
  registry,
  siblingCount,
  anchor,
}: CollapsedTurnSummaryProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    // Don't toggle when clicking inside an expanded tool row (let it handle its own click)
    if (expanded) {
      const target = e.target as HTMLElement;
      if (target.closest('.crispy-blocks-tool')) return;
    }
    setExpanded((prev) => !prev);
  }, [expanded]);

  if (blocks.length === 0) return null;

  // Group by tool name for the collapsed summary
  const grouped = groupByToolName(blocks);

  if (expanded) {
    return (
      <div className="crispy-collapsed-turn crispy-collapsed-turn--expanded">
        <button
          className="crispy-collapsed-turn__toggle"
          onClick={handleToggle}
          aria-label="Collapse ephemeral tools"
          title="Collapse"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M1 3 L5 7 L9 3" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </button>
        <div className="crispy-collapsed-turn__tools">
          {blocks.map((block) => (
            <div key={`tool-${block.id}`} data-run-id={block.id}>
              <ToolBlockRenderer
                block={block}
                anchor={anchor}
                registry={registry}
                siblingCount={siblingCount}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="crispy-collapsed-turn"
      onClick={handleToggle}
      role="button"
      tabIndex={0}
      aria-label={`${blocks.length} ephemeral tool calls (click to expand)`}
    >
      <button
        className="crispy-collapsed-turn__toggle"
        aria-label="Expand ephemeral tools"
        title="Expand"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <path d="M3 1 L7 5 L3 9" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>
      <div className="crispy-collapsed-turn__summary">
        {Array.from(grouped.entries()).map(([toolName, count], i) => {
          const data = getToolData(toolName);
          return (
            <span key={toolName} className="crispy-collapsed-turn__group">
              {i > 0 && <span className="crispy-collapsed-turn__separator">{'\u00b7'}</span>}
              <span className="crispy-collapsed-turn__icon">{data.icon}</span>
              <span className="crispy-collapsed-turn__label">{toolName}</span>
              {count > 1 && (
                <span className="crispy-collapsed-turn__count">[{count}]</span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
