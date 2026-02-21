/**
 * Bash Tool Renderer
 *
 * Shows command + description in header, output + exit code in body.
 *
 * @module webview/renderers/tools/BashTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { formatCount } from './shared/tool-utils.js';
import { renderAnsi, hasAnsi, stripAnsi } from './shared/ansi.js';
import { isBashInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('Bash');

export function BashTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isBashInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { command: string; description?: string; timeout?: number })
    : null;

  const command = input?.command ?? '';
  const description = input?.description;

  // Result summary (strip ANSI for line count)
  const rawResultText = entry.result && typeof entry.result.content === 'string' ? entry.result.content : null;
  const resultText = rawResultText ? stripAnsi(rawResultText) : null;
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Failed' : formatCount(resultText, 'line')
    : undefined;
  const useAnsiRender = rawResultText !== null && hasAnsi(rawResultText);

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeTextColor="#1e1e1e"
      badgeLabel="Bash"
      panelOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <>
          {description && <span className="crispy-tool-description">{description}</span>}
          <code className="u-mono-pill crispy-tool-bash-inline">{command}</code>
        </>
      }
    >
      {/* Result output */}
      {entry.result && (
        <div className="crispy-tool-result">
          <pre className={`crispy-tool-result__text ${entry.result.is_error ? 'crispy-tool-result__text--error' : ''}`}>
            {useAnsiRender
              ? renderAnsi(rawResultText!)
              : (resultText ?? JSON.stringify(entry.result.content, null, 2))}
          </pre>
        </div>
      )}
    </ToolCardShell>
  );
}
