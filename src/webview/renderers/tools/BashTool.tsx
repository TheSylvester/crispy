/**
 * Bash Tool Renderer
 *
 * Shows command + description in header, output + exit code in body.
 *
 * @module webview/renderers/tools/BashTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { isBashInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

export function BashTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isBashInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { command: string; description?: string; timeout?: number })
    : null;

  const command = input?.command ?? '';
  const description = input?.description;

  // Result summary
  const resultText = entry.result && typeof entry.result.content === 'string' ? entry.result.content : null;
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Failed' : formatLineCount(resultText)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={'\uD83D\uDCBB'}
      badgeColor="#f59e0b"
      badgeTextColor="#1e1e1e"
      badgeLabel="Bash"
      resultSummary={resultSummary}
      headerContent={
        <>
          {description && <span className="crispy-tool-description">{description}</span>}
          <code className="crispy-tool-bash-inline">{command}</code>
        </>
      }
    >
      {/* Result output */}
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

function formatLineCount(text: string | null): string {
  if (!text) return '';
  const lines = text.split('\n').length;
  return `${lines} line${lines !== 1 ? 's' : ''}`;
}
