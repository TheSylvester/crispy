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
import { isWebSearchInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

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
    ? entry.result.is_error ? 'Failed' : formatLineCount(resultText)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={'\uD83C\uDF10'}
      badgeColor="#8b5cf6"
      badgeLabel="WebSearch"
      panelOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <span className="crispy-tool-secondary">{query}</span>
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

/** Extract display text from tool_result content (string or array of text blocks). */
function extractResultText(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null && 'text' in b && typeof b.text === 'string')
      .map((b) => b.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

function formatLineCount(text: string | null): string {
  if (!text) return '';
  const lines = text.split('\n').length;
  return `${lines} line${lines !== 1 ? 's' : ''}`;
}
