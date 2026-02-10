/**
 * Tool Card Shell — shared <details> wrapper for all tool renderers
 *
 * Matches Leto's minimalist tool-card design:
 * - Transparent background, no borders
 * - Compact summary row: icon + badge + header content + status
 * - Hover background on summary
 * - Body indented under the card
 *
 * @module webview/renderers/tools/shared/ToolCardShell
 */

import { useToolEntry } from '../../../context/ToolRegistryContext.js';
import { ToolBadge } from './ToolBadge.js';
import { StatusIndicator } from './StatusIndicator.js';

interface ToolCardShellProps {
  toolId: string;
  icon: string;
  badgeColor: string;
  badgeLabel: string;
  badgeTextColor?: string;
  defaultOpen?: boolean;
  /** Result summary text (e.g. "Applied", "42 lines") */
  resultSummary?: string;
  /** Render prop for tool-specific summary content in the header */
  headerContent?: React.ReactNode;
  /** Body content shown when expanded */
  children?: React.ReactNode;
}

export function ToolCardShell({
  toolId,
  icon,
  badgeColor,
  badgeLabel,
  badgeTextColor,
  defaultOpen = false,
  resultSummary,
  headerContent,
  children,
}: ToolCardShellProps): React.JSX.Element {
  const entry = useToolEntry(toolId);
  const status = entry?.status ?? 'running';
  const statusClass = status === 'complete' ? 'tool-success' : status === 'error' ? 'tool-error' : '';

  return (
    <details className={`crispy-tool-card ${statusClass}`} open={defaultOpen || undefined}>
      <summary className="crispy-tool-card__summary">
        <span className="crispy-tool-header-content">
          <span className="crispy-tool-icon">{icon}</span>
          <ToolBadge color={badgeColor} textColor={badgeTextColor} label={badgeLabel} />
          {headerContent}
        </span>
        <StatusIndicator status={status} summary={resultSummary} />
      </summary>
      {children && (
        <div className="crispy-tool-card__body">
          {children}
        </div>
      )}
    </details>
  );
}
