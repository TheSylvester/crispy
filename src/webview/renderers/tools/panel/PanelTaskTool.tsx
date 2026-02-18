/**
 * Panel Task Tool — panel-optimized renderer for Task (sub-agent) tools
 *
 * Shows agent info, prompt, nested children via ToolPanelCard dispatch,
 * and result — all always-expanded with a tree-like layout.
 *
 * @module webview/renderers/tools/panel/PanelTaskTool
 */

import { CrispyMarkdown } from '../../CrispyMarkdown.js';
import { useToolEntry } from '../../../context/ToolRegistryContext.js';
import { ToolBadge } from '../shared/ToolBadge.js';
import { PanelStatusBar } from './PanelBashTool.js';
import { ToolPanelCard } from './ToolPanelCard.js';
import { isAgentInput } from '../../../../core/transcript.js';
import type { ToolInput } from '../../../../core/transcript.js';

export function PanelTaskTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isAgentInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { prompt: string; subagent_type: string; description: string })
    : null;

  const agentType = input?.subagent_type ?? 'agent';
  const description = input?.description ?? '';
  const prompt = input?.prompt ?? null;

  const resultText = extractResultText(entry.result?.content);

  return (
    <div className={`crispy-panel-card ${entry.status === 'error' ? 'crispy-panel-card--error' : ''}`}>
      {/* Header */}
      <div className="crispy-panel-card__header">
        <span className="crispy-tool-icon">{'\uD83E\uDD16'}</span>
        <ToolBadge color="#64748b" label={agentType} />
        <span className="crispy-panel-card__description">{description}</span>
        <PanelStatusBar status={entry.status} />
      </div>

      {/* Prompt — collapsible since prompts can be long */}
      {prompt && (
        <details className="crispy-panel-card__section" open>
          <summary className="crispy-panel-card__section-label crispy-panel-card__section-label--clickable">
            Prompt
          </summary>
          <div className="crispy-panel-card__prompt prose">
            <CrispyMarkdown>{prompt}</CrispyMarkdown>
          </div>
        </details>
      )}

      {/* Nested child tools — rendered via panel dispatch */}
      {entry.childIds.length > 0 && (
        <div className="crispy-panel-card__children">
          {entry.childIds.map(childId => (
            <ToolPanelCard key={childId} toolId={childId} />
          ))}
        </div>
      )}

      {/* Result output */}
      {entry.result && resultText && (
        <div className="crispy-panel-card__section">
          <div className="crispy-panel-card__section-label">Result</div>
          <div className={`crispy-panel-card__prose prose assistant-text ${entry.result.is_error ? 'crispy-panel-card__output--error' : ''}`}>
            <CrispyMarkdown>{resultText}</CrispyMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

/** Extract display text from tool_result content. */
function extractResultText(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null && 'text' in b && typeof b.text === 'string')
      .map(b => b.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}
