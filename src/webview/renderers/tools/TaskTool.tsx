/**
 * Task Tool Renderer
 *
 * Shows agent type + description in header. Renders the sub-agent's
 * initial prompt, nested child tools, and the final result — all
 * inside the expanded tool card.
 *
 * - Prompt renders as a user-style message (first block)
 * - Child tools render via ToolCard dispatch
 * - Result renders as rich markdown (same pipeline as AssistantTextRenderer)
 *
 * @module webview/renderers/tools/TaskTool
 */

import { CrispyMarkdown } from '../CrispyMarkdown.js';
import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { formatCount, extractResultText } from './shared/tool-utils.js';
import { isAgentInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

import { ToolCard } from './ToolCard.js';

const meta = getToolMeta('Task');

export function TaskTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isAgentInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { prompt: string; subagent_type: string; description: string })
    : null;

  const agentType = input?.subagent_type ?? 'agent';
  const description = input?.description ?? '';
  const prompt = input?.prompt ?? null;

  // Result text — content can be a string or array of text blocks
  const resultText = extractResultText(entry.result?.content);
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Failed' : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel={agentType}
      defaultOpen={false}
      resultSummary={resultSummary}
      headerContent={
        <span className="crispy-tool-description">{description}</span>
      }
    >
      {/* Initial prompt — rendered as user-style message */}
      {prompt && (
        <div className="prose user-text crispy-task-prompt">
          <CrispyMarkdown>{prompt}</CrispyMarkdown>
        </div>
      )}

      {/* Nested child tools */}
      {entry.childIds.length > 0 && (
        <div className="crispy-tool-card__children">
          {entry.childIds.map((childId) => (
            <ToolCard key={childId} toolId={childId} />
          ))}
        </div>
      )}

      {/* Result output — rich markdown rendering */}
      {entry.result && resultText && (
        <div className={`prose assistant-text crispy-task-result ${entry.result.is_error ? 'crispy-task-result--error' : ''}`}>
          <CrispyMarkdown>{resultText}</CrispyMarkdown>
        </div>
      )}
    </ToolCardShell>
  );
}
