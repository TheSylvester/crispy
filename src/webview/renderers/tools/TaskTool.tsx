/**
 * Task Tool Renderer
 *
 * Shows agent type + description in header. Renders nested children
 * via ToolCard dispatch for recursive sub-agent tool display.
 *
 * @module webview/renderers/tools/TaskTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { isAgentInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

import { ToolCard } from './ToolCard.js';

export function TaskTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isAgentInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { prompt: string; subagent_type: string; description: string })
    : null;

  const agentType = input?.subagent_type ?? 'agent';
  const description = input?.description ?? '';

  // Result summary
  const resultText = entry.result && typeof entry.result.content === 'string' ? entry.result.content : null;
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Failed' : formatLineCount(resultText)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={'\uD83E\uDD16'}
      badgeColor="#64748b"
      badgeLabel={agentType}
      defaultOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <span className="crispy-tool-description">{description}</span>
      }
    >
      {/* Nested child tools */}
      {entry.childIds.length > 0 && (
        <div className="crispy-tool-card__children">
          {entry.childIds.map((childId) => (
            <ToolCard key={childId} toolId={childId} />
          ))}
        </div>
      )}

      {/* Error result */}
      {entry.result && entry.result.is_error && (
        <div className="crispy-tool-result">
          <pre className="crispy-tool-result__text crispy-tool-result__text--error">
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
