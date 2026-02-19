/**
 * Panel Edit Tool — panel-optimized renderer for file edits
 *
 * Always-expanded card with full diff view. Uses the same DiffView
 * component as the inline renderer but with more generous max height
 * since the panel has dedicated space.
 *
 * @module webview/renderers/tools/panel/PanelEditTool
 */

import { useToolEntry } from '../../../context/ToolRegistryContext.js';
import { ToolBadge } from '../shared/ToolBadge.js';
import { FilePath } from '../shared/FilePath.js';
import { DiffView } from '../shared/DiffView.js';
import { getToolMeta } from '../shared/tool-metadata.js';
import { inferLanguage } from '../shared/tool-utils.js';
import { PanelStatusBar } from './PanelBashTool.js';
import { isFileEditInput } from '../../../../core/transcript.js';
import type { ToolInput } from '../../../../core/transcript.js';

const meta = getToolMeta('Edit');

export function PanelEditTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isFileEditInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { file_path: string; old_string: string; new_string: string })
    : null;

  const filePath = input?.file_path ?? '(unknown)';
  const oldString = input?.old_string ?? '';
  const newString = input?.new_string ?? '';

  // Diff stats
  const oldLines = oldString.split('\n').length;
  const newLines = newString.split('\n').length;

  return (
    <div className={`crispy-panel-card ${entry.status === 'error' ? 'crispy-panel-card--error' : ''}`}>
      {/* Header */}
      <div className="crispy-panel-card__header">
        <span className="crispy-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.badgeColor} label="Edit" />
        <FilePath path={filePath} />
        <span className="crispy-diff-stats">
          <span className="crispy-diff-stats-added">+{newLines}</span>
          <span className="crispy-diff-stats-removed">-{oldLines}</span>
        </span>
        <PanelStatusBar status={entry.status} />
      </div>

      {/* Diff — always expanded, generous height for panel context */}
      {(oldString || newString) && (
        <div className="crispy-panel-card__section">
          <DiffView
            oldText={oldString}
            newText={newString}
            language={inferLanguage(filePath)}
            maxHeight={600}
          />
        </div>
      )}

      {/* Error output */}
      {entry.result && entry.result.is_error && (
        <div className="crispy-panel-card__section">
          <div className="crispy-panel-card__section-label">Error</div>
          <pre className="crispy-panel-card__output crispy-panel-card__output--error">
            {typeof entry.result.content === 'string'
              ? entry.result.content
              : JSON.stringify(entry.result.content, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
