/**
 * ToolSearch Tool Views — custom renderers for deferred tool loading
 *
 * ToolSearch is pure plumbing: it loads deferred tools before they can be
 * called. High-frequency, low-information — the renderer keeps it minimal.
 *
 * - Compact: dot-line with colored "toolsearch" + query + loaded count
 * - Expanded: same header + list of loaded tools
 *
 * @module webview/blocks/views/toolsearch-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData, extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { ToolCard } from './ToolCard.js';
import { CompactBlock } from './default-views.js';

const meta = getToolData('ToolSearch');

interface ToolSearchInput {
  query?: string;
  max_results?: number;
}

interface ToolReference {
  type: 'tool_reference';
  tool_name: string;
}

/**
 * Extract loaded tool names from ToolSearch result content.
 * Results are arrays of `{type: "tool_reference", tool_name}` objects.
 */
function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b): b is ToolReference =>
        typeof b === 'object' &&
        b !== null &&
        (b as Record<string, unknown>).type === 'tool_reference' &&
        typeof (b as Record<string, unknown>).tool_name === 'string',
    )
    .map((b) => b.tool_name);
}

/**
 * Format the query for display — strip the "select:" prefix since
 * the badge already communicates what this tool does.
 */
function formatQuery(query: string): string {
  return query.replace(/^select:/, '');
}

// ============================================================================
// Compact View
// ============================================================================

export function ToolSearchCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const subject = extractSubject(block);

  return (
    <CompactBlock
      icon={meta.icon}
      color={meta.color}
      name="ToolSearch"
      subject={subject}
      status={status}
    />
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function ToolSearchExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as ToolSearchInput;
  const query = input.query ?? '(unknown)';
  const displayQuery = formatQuery(query);

  const toolNames = result ? extractToolNames(result.content) : [];
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : toolNames.length > 0
        ? `${toolNames.length} tool${toolNames.length !== 1 ? 's' : ''}`
        : 'No tools'
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="ToolSearch" />
        <span className="u-mono-pill crispy-tool-secondary">{displayQuery}</span>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {result && (
        <div className="crispy-blocks-tool-body">
          {result.is_error ? (
            <pre className="crispy-tool-result__text crispy-tool-result__text--error">
              {JSON.stringify(result.content, null, 2)}
            </pre>
          ) : toolNames.length > 0 ? (
            <div className="crispy-tool-result__text">
              {toolNames.map((name) => (
                <span key={name} className="u-mono-pill" style={{ marginRight: '0.4em', marginBottom: '0.3em', display: 'inline-block' }}>
                  {name}
                </span>
              ))}
            </div>
          ) : (
            <pre className="crispy-tool-result__text">No tools loaded</pre>
          )}
        </div>
      )}
    </ToolCard>
  );
}
