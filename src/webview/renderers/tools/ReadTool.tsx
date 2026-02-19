/**
 * Read Tool Renderer
 *
 * Shows file path + line range in header. Body collapsed by default.
 *
 * @module webview/renderers/tools/ReadTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { FilePath } from './shared/FilePath.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { formatCount } from './shared/tool-utils.js';
import { isFileReadInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('Read');

export function ReadTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isFileReadInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { file_path: string; offset?: number; limit?: number })
    : null;

  const filePath = input?.file_path ?? '(unknown)';

  let lineRange: string | undefined;
  if (input?.offset != null || input?.limit != null) {
    const start = (input?.offset ?? 0) + 1;
    if (input?.limit != null) {
      lineRange = `:${start}-${start + input.limit - 1}`;
    } else {
      lineRange = `:${start}+`;
    }
  }

  // Result summary
  const resultText = entry.result && typeof entry.result.content === 'string' ? entry.result.content : null;
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Not found' : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel="Read"
      panelOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <>
          <FilePath path={filePath} lineRange={lineRange} />
        </>
      }
    >
      {/* Result: file content */}
      {entry.result && (
        <div className="crispy-tool-result">
          <pre className={`crispy-tool-result__text ${entry.result.is_error ? 'crispy-tool-result__text--error' : ''}`}>
            {typeof entry.result.content === 'string' ? entry.result.content : JSON.stringify(entry.result.content, null, 2)}
          </pre>
        </div>
      )}
    </ToolCardShell>
  );
}
