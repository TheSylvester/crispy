/**
 * Glob Tool Renderer
 *
 * Shows pattern + search path in header, match list in body.
 *
 * @module webview/renderers/tools/GlobTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { isGlobInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

export function GlobTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isGlobInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { pattern: string; path?: string })
    : null;

  const pattern = input?.pattern ?? '(unknown)';
  const searchPath = input?.path;

  // Result summary
  const resultText = entry.result && typeof entry.result.content === 'string' ? entry.result.content : null;
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Error' : extractFileCount(resultText)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={'\uD83D\uDCC2'}
      badgeColor="#d946ef"
      badgeLabel="Glob"
      panelOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <>
          <span className="crispy-tool-secondary">{pattern}</span>
          {searchPath && <span className="crispy-tool-description">in {searchPath}</span>}
        </>
      }
    >
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

function extractFileCount(text: string | null): string {
  if (!text) return '';
  const lines = text.trim().split('\n').filter(Boolean);
  return `${lines.length} file${lines.length !== 1 ? 's' : ''}`;
}
