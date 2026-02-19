/**
 * Edit Tool Renderer
 *
 * Shows file path + diff stats in header, diff view in body.
 *
 * @module webview/renderers/tools/EditTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { FilePath } from './shared/FilePath.js';
import { DiffView } from './shared/DiffView.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { inferLanguage } from './shared/tool-utils.js';
import { isFileEditInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('Edit');

export function EditTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isFileEditInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { file_path: string; old_string: string; new_string: string })
    : null;

  const filePath = input?.file_path ?? '(unknown)';
  const oldString = input?.old_string ?? '';
  const newString = input?.new_string ?? '';

  // Compute diff stats
  const oldLines = oldString.split('\n').length;
  const newLines = newString.split('\n').length;

  const resultSummary = entry.result
    ? entry.result.is_error ? 'Failed' : 'Applied'
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel="Edit"
      defaultOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <>
          <FilePath path={filePath} />
          <span className="crispy-diff-stats">
            <span className="crispy-diff-stats-added">+{newLines}</span>
            <span className="crispy-diff-stats-removed">-{oldLines}</span>
          </span>
        </>
      }
    >
      {(oldString || newString) && <DiffView oldText={oldString} newText={newString} language={inferLanguage(filePath)} />}

      {entry.result && entry.result.is_error && (
        <div className="crispy-tool-result">
          <pre className="crispy-tool-result__text crispy-tool-result__text--error">
            {typeof entry.result.content === 'string' ? entry.result.content : JSON.stringify(entry.result.content, null, 2)}
          </pre>
        </div>
      )}
    </ToolCardShell>
  );
}
