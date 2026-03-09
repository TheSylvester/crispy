/**
 * Edit Tool Views — custom renderers for Edit tool
 *
 * - Compact: dot-line with colored "edit" + file path + diff stats + status
 * - Expanded: file path + DiffView component
 *
 * @module webview/blocks/views/edit-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData, extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { FilePath } from '../../renderers/tools/shared/FilePath.js';
import { DiffView } from '../../renderers/tools/shared/DiffView.js';
import { inferLanguage } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';
import { useBlocksToolRegistry } from '../BlocksToolRegistryContext.js';
import { DotLine, DotLineStatus } from './default-views.js';

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
  const filePath = input.file_path ?? extractSubject(block);
  const oldLines = (input.old_string ?? '').split('\n').length;
  const newLines = (input.new_string ?? '').split('\n').length;

  return (
    <DotLine
      icon={meta.icon}
      color={meta.color}
      name="edit"
      subject={<FilePath path={filePath} />}
      meta={<span className="crispy-diff-stats">
        <span className="crispy-diff-stats-added">+{newLines}</span>
        {' '}
        <span className="crispy-diff-stats-removed">-{oldLines}</span>
      </span>}
      result={<DotLineStatus status={status} />}
    />
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function EditExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as EditInput;
  const filePath = input.file_path ?? '(unknown)';
  const oldString = input.old_string ?? '';
  const newString = input.new_string ?? '';
  const oldLines = oldString.split('\n').length;
  const newLines = newString.split('\n').length;

  // Read the computed startLine from the registry (set when tool_result resolves)
  const registry = useBlocksToolRegistry();
  const toolMeta = registry.useToolMeta(block.id);
  const startLine = (toolMeta?.startLine as number) ?? 1;

  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : 'Applied'
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
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
    </>}>
      <div className="crispy-blocks-tool-body">
        {(oldString || newString) && (
          <DiffView
            oldText={oldString}
            newText={newString}
            language={inferLanguage(filePath)}
            startLine={startLine}
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
    </ToolCard>
  );
}
