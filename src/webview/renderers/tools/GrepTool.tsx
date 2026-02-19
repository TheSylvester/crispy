/**
 * Grep Tool Renderer
 *
 * Shows pattern + scope in header, matches in body.
 *
 * @module webview/renderers/tools/GrepTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { formatCount } from './shared/tool-utils.js';
import { isGrepInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('Grep');

export function GrepTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isGrepInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { pattern: string; path?: string; glob?: string; type?: string })
    : null;

  const pattern = input?.pattern ?? '(unknown)';
  const scope = input?.path ?? input?.glob ?? input?.type;

  // Result summary
  const resultText = entry.result && typeof entry.result.content === 'string' ? entry.result.content : null;
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Error' : formatCount(resultText, 'match', true)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeTextColor="#1e1e1e"
      badgeLabel="Grep"
      panelOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <>
          <span className="u-mono-pill crispy-tool-secondary">{pattern}</span>
          {scope && <span className="crispy-tool-description">in {scope}</span>}
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
