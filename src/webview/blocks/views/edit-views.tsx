/**
 * Edit Tool Views — custom renderers for Edit tool
 *
 * - Compact: file path + diff stats + status
 * - Expanded: file path + DiffView component
 *
 * @module webview/blocks/views/edit-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { FilePath } from '../../renderers/tools/shared/FilePath.js';
import { DiffView } from '../../renderers/tools/shared/DiffView.js';
import { inferLanguage } from '../../renderers/tools/shared/tool-utils.js';

const meta = getToolData('Edit');

interface EditInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
}

// ============================================================================
// Compact View
// ============================================================================

export function EditCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as EditInput;
  const filePath = input.file_path ?? '(unknown)';
  const oldLines = (input.old_string ?? '').split('\n').length;
  const newLines = (input.new_string ?? '').split('\n').length;

  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : 'Applied'
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label="Edit" />
      <FilePath path={filePath} />
      <span className="crispy-diff-stats">
        <span className="crispy-diff-stats-added">+{newLines}</span>
        <span className="crispy-diff-stats-removed">-{oldLines}</span>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function EditExpandedView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as EditInput;
  const filePath = input.file_path ?? '(unknown)';
  const oldString = input.old_string ?? '';
  const newString = input.new_string ?? '';
  const oldLines = oldString.split('\n').length;
  const newLines = newString.split('\n').length;

  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : 'Applied'
    : undefined;

  return (
    <details className="crispy-blocks-tool-card" open>
      <summary className="crispy-blocks-tool-summary">
        <span className="crispy-blocks-tool-header">
          <span className="crispy-blocks-tool-icon">{meta.icon}</span>
          <ToolBadge color={meta.color} label="Edit" />
          <FilePath path={filePath} />
          <span className="crispy-diff-stats">
            <span className="crispy-diff-stats-added">+{newLines}</span>
            <span className="crispy-diff-stats-removed">-{oldLines}</span>
          </span>
        </span>
        <StatusIndicator status={status} summary={resultSummary} />
      </summary>
      <div className="crispy-blocks-tool-body">
        {(oldString || newString) && (
          <DiffView
            oldText={oldString}
            newText={newString}
            language={inferLanguage(filePath)}
          />
        )}
        {result && result.is_error && (
          <pre className="crispy-tool-result__text crispy-tool-result__text--error">
            {typeof result.content === 'string'
              ? result.content
              : JSON.stringify(result.content, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}
