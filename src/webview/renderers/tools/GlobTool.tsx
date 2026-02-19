/**
 * Glob Tool Renderer
 *
 * Shows pattern + search path in header, match list in body.
 *
 * @module webview/renderers/tools/GlobTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { formatCount } from './shared/tool-utils.js';
import { isGlobInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('Glob');

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
    ? entry.result.is_error ? 'Error' : formatCount(resultText, 'file', true)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel="Glob"
      panelOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <>
          <span className="u-mono-pill crispy-tool-secondary">{pattern}</span>
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
