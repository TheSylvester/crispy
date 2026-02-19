/**
 * WebSearch Tool Renderer
 *
 * Shows search query in header, result content in body as <pre>.
 * Collapsed by default (verbose results).
 *
 * @module webview/renderers/tools/WebSearchTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { formatCount, extractResultText } from './shared/tool-utils.js';
import { isWebSearchInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('WebSearch');

export function WebSearchTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isWebSearchInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { query: string })
    : null;

  const query = input?.query ?? '(unknown)';

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
      badgeLabel="WebSearch"
      panelOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <span className="u-mono-pill crispy-tool-secondary">{query}</span>
      }
    >
      {entry.result && resultText && (
        <div className="crispy-tool-result">
          <pre className={`crispy-tool-result__text ${entry.result.is_error ? 'crispy-tool-result__text--error' : ''}`}>
            {resultText}
          </pre>
        </div>
      )}
    </ToolCardShell>
  );
}
