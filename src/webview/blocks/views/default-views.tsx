/**
 * Default Views — generic collapsed + compact views for all tools
 *
 * Provides `defaultToolViews()` helper that creates standard views
 * for any tool. Tools can override specific views while keeping defaults
 * for others.
 *
 * @module webview/blocks/views/default-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps, ToolDefinition } from '../types.js';
import { extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';

// ============================================================================
// Default Views Helper
// ============================================================================

/**
 * Create standard collapsed + compact views for a tool.
 *
 * Used as a base for most tools. Tools only need to provide a custom
 * expanded view, using these defaults for collapsed/compact.
 *
 * @param def - Partial tool definition with icon and activity
 * @returns Views object with collapsed and compact renderers
 */
export function defaultToolViews(def: Pick<ToolDefinition, 'icon' | 'activity' | 'color'>): {
  collapsed: (props: ToolViewProps) => ReactNode;
  compact: (props: ToolViewProps) => ReactNode;
} {
  return {
    collapsed: (props) => <DefaultCollapsedView {...props} def={def} />,
    compact: (props) => <DefaultCompactView {...props} def={def} />,
  };
}

// ============================================================================
// Collapsed View — single-line summary for activity groups
// ============================================================================

interface DefaultCollapsedViewProps extends ToolViewProps {
  def: Pick<ToolDefinition, 'icon' | 'activity'>;
}

function DefaultCollapsedView({ block, def }: DefaultCollapsedViewProps): ReactNode {
  const subject = extractSubject(block);

  return (
    <span className="crispy-blocks-collapsed-item">
      <span className="crispy-blocks-collapsed-icon">{def.icon}</span>
      <span className="crispy-blocks-collapsed-verb">{def.activity.pastVerb}</span>
      <span className="crispy-blocks-collapsed-subject">{subject}</span>
    </span>
  );
}

// ============================================================================
// Compact View — single row with badge, subject, and status
// ============================================================================

interface DefaultCompactViewProps extends ToolViewProps {
  def: Pick<ToolDefinition, 'icon' | 'activity' | 'color'>;
}

function DefaultCompactView({ block, result, status, def }: DefaultCompactViewProps): ReactNode {
  const subject = extractSubject(block);
  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{def.icon}</span>
      <ToolBadge color={def.color} label={block.name} />
      <span className="crispy-blocks-compact-subject">{subject}</span>
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}

// ============================================================================
// Generic Expanded View — YAML fallback for unknown tools
// ============================================================================

/**
 * Generic expanded view that shows tool input as YAML and result as text.
 * Used for unknown/MCP tools without custom renderers.
 */
export function GenericExpandedView({ block, result, status }: ToolViewProps): ReactNode {
  const inputYaml = formatAsYaml(block.input as Record<string, unknown>);
  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <details className="crispy-blocks-generic-tool" open>
      <summary className="crispy-blocks-generic-summary">
        <span className="crispy-blocks-generic-name">{block.name}</span>
        <StatusIndicator status={status} summary={resultSummary} />
      </summary>
      <div className="crispy-blocks-generic-body">
        <pre className="crispy-blocks-generic-input">{inputYaml}</pre>
        {result && (
          <pre className={`crispy-blocks-generic-result ${result.is_error ? 'crispy-blocks-generic-result--error' : ''}`}>
            {resultText ?? JSON.stringify(result.content, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

/**
 * Simple YAML-like formatting for tool input display.
 */
function formatAsYaml(input: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      if (value.includes('\n')) {
        lines.push(`${key}: |`);
        for (const line of value.split('\n')) {
          lines.push(`  ${line}`);
        }
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else if (value === undefined || value === null) {
      // Skip undefined/null
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join('\n');
}
