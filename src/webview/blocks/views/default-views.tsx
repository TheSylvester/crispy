/**
 * Default Views — generic compact view for all tools
 *
 * Provides `defaultToolViews()` helper that creates standard views
 * for any tool. Tools can override specific views while keeping defaults
 * for others.
 *
 * Also provides:
 * - `CompactBlock` — two-row compact view (header row + subject pill),
 *   aligned with BashCompactView. Used by all per-tool compact views.
 * - `DotLine` — single-line condensed view (icon + badge + dots + status).
 *   Used for condensed mode only.
 *
 * @module webview/blocks/views/default-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps, ToolDefinition } from '../types.js';
import { extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';

// ============================================================================
// CompactBlock — two-row compact view aligned with BashCompactView
// ============================================================================

interface CompactBlockProps {
  icon: ReactNode;
  /** Tool color for the badge */
  color: string;
  /** Lowercase tool name displayed in badge */
  name: string;
  /** Subject shown inline in the header row (file path, pattern, description text) */
  subject?: ReactNode;
  /** Description text — shown inline in header row (muted italic) */
  description?: string;
  /** Extra badges (e.g. "background", timeout) — inserted after name badge */
  badges?: ReactNode;
  /** Metadata displayed in header row after subject (e.g. diff stats) */
  meta?: ReactNode;
  /** Optional code pill on a second row (e.g. Bash command) */
  codePill?: string;
  /** Tool status */
  status: 'running' | 'complete' | 'error';
}

/**
 * Compact block view — single row with optional second-row code pill.
 *
 * Row 1: icon + colored badge + [extra badges] + [subject] + [description] + [meta] + status
 * Row 2 (optional): code pill (e.g. Bash command)
 *
 * Visually aligned with BashCompactView — same CSS classes, same layout.
 */
export function CompactBlock({ icon, color, name, subject, description, badges, meta, codePill, status }: CompactBlockProps): ReactNode {
  return (
    <div className="crispy-blocks-compact-block">
      <div className="crispy-blocks-compact-row">
        <span className="crispy-blocks-compact-icon">{icon}</span>
        <ToolBadge color={color} label={name} />
        {badges}
        {subject && (
          <span className="crispy-blocks-dot-line__subject">{subject}</span>
        )}
        {description && (
          <span className="crispy-blocks-tool-description">{description}</span>
        )}
        {meta}
        <DotLineStatus status={status} />
      </div>
      {codePill && (
        <code className="u-mono-pill crispy-tool-subject-pill">{codePill}</code>
      )}
    </div>
  );
}

// ============================================================================
// DotLine — single-line condensed view (for condensed mode only)
// ============================================================================

interface DotLineProps {
  icon: ReactNode;
  /** Tool color for the name text */
  color: string;
  /** Lowercase tool name displayed in mono */
  name: string;
  /** Primary subject (file path, command, pattern) — mono, blue */
  subject?: ReactNode;
  /** Description text — muted italic, used instead of subject for Bash descriptions */
  description?: string;
  /** Metadata displayed after subject but before the dot gap (e.g. diff stats) */
  meta?: ReactNode;
  /** Result area content */
  result?: ReactNode;
}

/**
 * Colored mono + dot leader condensed view.
 *
 * Layout: icon + colored name + (subject | description) + dot leader + result
 */
export function DotLine({ icon, color, name, subject, description, meta, result }: DotLineProps): ReactNode {
  return (
    <div className="crispy-blocks-dot-line">
      <span className="crispy-blocks-dot-line__icon">{icon}</span>
      <ToolBadge color={color} label={name} />
      {description
        ? <span className="crispy-blocks-dot-line__desc">{description}</span>
        : subject && <span className="crispy-blocks-dot-line__subject">{subject}</span>
      }
      {meta && <span className="crispy-blocks-dot-line__meta">{meta}</span>}
      <span className="crispy-blocks-dot-line__dots" />
      {result && <span className="crispy-blocks-dot-line__result">{result}</span>}
    </div>
  );
}

/**
 * Status icon only (no text summary) — for dot-line and compact-block result area.
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
// Compact View — CompactBlock with badge, subject, and status
// ============================================================================

interface DefaultCompactViewProps extends ToolViewProps {
  def: Pick<ToolDefinition, 'icon' | 'activity' | 'color'>;
}

function DefaultCompactView({ block, status, def }: DefaultCompactViewProps): ReactNode {
  const subject = extractSubject(block);

  return (
    <CompactBlock
      icon={def.icon}
      color={def.color}
      name={block.name.toLowerCase()}
      subject={subject}
      status={status}
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
