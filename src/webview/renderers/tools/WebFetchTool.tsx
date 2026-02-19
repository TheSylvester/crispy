/**
 * WebFetch Tool Renderer
 *
 * Shows truncated URL in header, prompt as description, result as markdown.
 * Collapsed by default (verbose results).
 *
 * @module webview/renderers/tools/WebFetchTool
 */

import { CrispyMarkdown } from '../CrispyMarkdown.js';
import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { formatCount, extractResultText } from './shared/tool-utils.js';
import { isWebFetchInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('WebFetch');

export function WebFetchTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isWebFetchInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { url: string; prompt: string })
    : null;

  const url = input?.url ?? '(unknown)';
  const prompt = input?.prompt ?? null;
  const truncatedUrl = url.length > 60 ? url.slice(0, 60) + '...' : url;

  // Result summary
  const resultText = extractResultText(entry.result?.content);
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Failed' : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel="WebFetch"
      panelOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <span className="u-mono-pill crispy-tool-secondary">{truncatedUrl}</span>
      }
    >
      {prompt && (
        <div className="crispy-tool-description">{prompt}</div>
      )}
      {entry.result && resultText && (
        <div className={`prose assistant-text crispy-task-result ${entry.result.is_error ? 'crispy-task-result--error' : ''}`}>
          <CrispyMarkdown>{resultText}</CrispyMarkdown>
        </div>
      )}
    </ToolCardShell>
  );
}
