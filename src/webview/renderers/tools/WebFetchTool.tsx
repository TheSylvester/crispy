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
import { isWebFetchInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

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
    ? entry.result.is_error ? 'Failed' : formatLineCount(resultText)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={'\uD83C\uDF0E'}
      badgeColor="#6366f1"
      badgeLabel="WebFetch"
      panelOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <span className="crispy-tool-secondary">{truncatedUrl}</span>
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
