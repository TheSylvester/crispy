/**
 * Panel Bash Tool — panel-optimized renderer for Bash commands
 *
 * Always-expanded card with prominent status bar, full output display,
 * and timing info. Unlike the inline BashTool which uses a compact
 * <details> collapsible, this is designed for the tool panel's wider
 * layout and detail-inspector UX.
 *
 * @module webview/renderers/tools/panel/PanelBashTool
 */

import { useToolEntry } from '../../../context/ToolRegistryContext.js';
import { ToolBadge } from '../shared/ToolBadge.js';
import { isBashInput } from '../../../../core/transcript.js';
import type { ToolInput } from '../../../../core/transcript.js';

export function PanelBashTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isBashInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { command: string; description?: string; timeout?: number })
    : null;

  const command = input?.command ?? '';
  const description = input?.description;

  const resultText = entry.result && typeof entry.result.content === 'string'
    ? entry.result.content
    : null;

  const isError = entry.result?.is_error ?? false;

  return (
    <div className={`crispy-panel-card ${entry.status === 'error' ? 'crispy-panel-card--error' : ''}`}>
      {/* Header — always visible */}
      <div className="crispy-panel-card__header">
        <span className="crispy-tool-icon">{'\uD83D\uDCBB'}</span>
        <ToolBadge color="#f59e0b" textColor="#1e1e1e" label="Bash" />
        {description && <span className="crispy-panel-card__description">{description}</span>}
        <PanelStatusBar status={entry.status} />
      </div>

      {/* Command — always shown, full width */}
      <div className="crispy-panel-card__section">
        <div className="crispy-panel-card__section-label">Command</div>
        <pre className="crispy-panel-card__code">{command}</pre>
      </div>

      {/* Output — full display, no truncation */}
      {entry.result && (
        <div className="crispy-panel-card__section">
          <div className="crispy-panel-card__section-label">
            {isError ? 'Error Output' : 'Output'}
          </div>
          <pre className={`crispy-panel-card__output ${isError ? 'crispy-panel-card__output--error' : ''}`}>
            {resultText ?? JSON.stringify(entry.result.content, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Prominent status bar with timing — shared across panel renderers */
function PanelStatusBar({ status }: { status: string }): React.JSX.Element {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.running;
  return (
    <span className={`crispy-panel-status ${config.className}`}>
      {config.icon} {config.label}
    </span>
  );
}

const STATUS_CONFIG: Record<string, { icon: string; label: string; className: string }> = {
  running:  { icon: '\u23f3', label: 'Running', className: 'crispy-status-pending' },
  complete: { icon: '\u2713', label: 'Done',    className: 'crispy-status-success' },
  error:    { icon: '\u2717', label: 'Failed',  className: 'crispy-status-error' },
};

export { PanelStatusBar, STATUS_CONFIG };
