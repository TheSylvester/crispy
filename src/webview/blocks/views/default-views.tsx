/**
 * Default Views — generic compact view for all tools
 *
 * Provides `defaultToolViews()` helper that creates standard views
 * for any tool. Tools can override specific views while keeping defaults
 * for others.
 *
 * Also provides `DotLine` — the shared "colored mono + dots" compact view
 * component used by all per-tool compact views.
 *
 * @module webview/blocks/views/default-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps, ToolDefinition } from '../types.js';
import { extractSubject } from '../tool-definitions.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';

// ============================================================================
// DotLine — shared colored mono + dots compact view
// ============================================================================

interface DotLineProps {
  icon: ReactNode;
  /** Tool color for the name text */
  color: string;
  /** Lowercase tool name displayed in mono */
  name: string;
  /** Primary subject (file path, command, pattern) — mono, blue */
  subject?: string;
  /** Description text — muted italic, used instead of subject for Bash descriptions */
  description?: string;
  /** Result area content */
  result?: ReactNode;
}

/**
 * Colored mono + dot leader compact view.
 *
 * Layout: icon + colored name + (subject | description) + dot leader + result
 */
export function DotLine({ icon, color, name, subject, description, result }: DotLineProps): ReactNode {
  return (
    <div className="crispy-blocks-dot-line">
      <span className="crispy-blocks-dot-line__icon">{icon}</span>
      <span className="crispy-blocks-dot-line__name" style={{ color }}>{name}</span>
      {description
        ? <span className="crispy-blocks-dot-line__desc">{description}</span>
        : subject && <span className="crispy-blocks-dot-line__subject">{subject}</span>
      }
      <span className="crispy-blocks-dot-line__dots" />
      {result && <span className="crispy-blocks-dot-line__result">{result}</span>}
    </div>
  );
}

/**
 * Status icon only (no text summary) — for dot-line result area.
 */
export function DotLineStatus({ status }: { status: 'running' | 'complete' | 'error' }): ReactNode {
  if (status === 'running') return <span className="crispy-status-pending">{'\u23F3'}</span>;
  if (status === 'error') return <span className="crispy-status-error">{'\u2717'}</span>;
  return <span className="crispy-status-success">{'\u2713'}</span>;
}

// ============================================================================
// Default Views Helper
// ============================================================================

/**
 * Create a standard compact view for a tool.
 *
 * Used as a base for most tools. Tools only need to provide a custom
 * expanded view, using this default for compact.
 *
 * @param def - Partial tool definition with icon and activity
 * @returns Views object with compact renderer
 */
export function defaultToolViews(def: Pick<ToolDefinition, 'icon' | 'activity' | 'color'>): {
  compact: (props: ToolViewProps) => ReactNode;
} {
  return {
    compact: (props) => <DefaultCompactView {...props} def={def} />,
  };
}

// ============================================================================
// Compact View — dot-line with badge, subject, and status
// ============================================================================

interface DefaultCompactViewProps extends ToolViewProps {
  def: Pick<ToolDefinition, 'icon' | 'activity' | 'color'>;
}

function DefaultCompactView({ block, status, def }: DefaultCompactViewProps): ReactNode {
  const subject = extractSubject(block);

  return (
    <DotLine
      icon={def.icon}
      color={def.color}
      name={block.name.toLowerCase()}
      subject={subject}
      result={<DotLineStatus status={status} />}
    />
  );
}

// ============================================================================
// Generic Expanded View — YAML fallback for unknown tools
// ============================================================================

/**
 * Generic expanded view that shows tool input as YAML and result as text.
 * Used for unknown/MCP tools without custom renderers.
 */
export function GenericExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const inputYaml = formatAsYaml(block.input as Record<string, unknown>);
  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} className="crispy-blocks-generic-tool" summaryClassName="crispy-blocks-generic-summary" summary={<>
      <span className="crispy-blocks-generic-name">{block.name}</span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      <div className="crispy-blocks-generic-body">
        <pre className="crispy-blocks-generic-input">{inputYaml}</pre>
        {result && (
          <pre className={`crispy-blocks-generic-result ${result.is_error ? 'crispy-blocks-generic-result--error' : ''}`}>
            {resultText ?? JSON.stringify(result.content, null, 2)}
          </pre>
        )}
      </div>
    </ToolCard>
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
