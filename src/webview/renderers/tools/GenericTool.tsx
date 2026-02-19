/**
 * Generic Tool — default fallback renderer for unrecognized tools
 *
 * Shows tool name badge, YAML input dump, and raw result text.
 *
 * @module webview/renderers/tools/GenericTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { YamlDump } from '../YamlDump.js';
import { formatLineCount } from './shared/tool-utils.js';
import type { ContentBlock } from '../../../core/transcript.js';

export function GenericTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const meta = getToolMeta(entry.name);
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Error' : formatLineCount(entry.result.content)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel={entry.name}
      resultSummary={resultSummary}
    >
      <details className="crispy-tool-input-details">
        <summary>Input</summary>
        <pre className="yaml-dump">
          <YamlDump value={entry.input} />
        </pre>
      </details>

      {entry.result && (
        <div className="crispy-tool-result">
          <ToolResultContent content={entry.result.content} isError={entry.result.is_error} />
        </div>
      )}
    </ToolCardShell>
  );
}

function ToolResultContent({ content, isError }: { content: string | ContentBlock[]; isError?: boolean }): React.JSX.Element {
  if (typeof content === 'string') {
    return (
      <pre className={`crispy-tool-result__text ${isError ? 'crispy-tool-result__text--error' : ''}`}>
        {content}
      </pre>
    );
  }

  return (
    <pre className="crispy-tool-result__text yaml-dump">
      <YamlDump value={content} />
    </pre>
  );
}
