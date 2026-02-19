/**
 * Panel Task Tool — panel-optimized renderer for Task (sub-agent) tools
 *
 * Shows agent info in the header, then renders prompt as plain markdown
 * (first child), nested tool cards, and the result as the last child.
 * Mirrors the inline TaskTool's layout: no section labels, no boxes —
 * just content flowing naturally in the tree.
 *
 * @module webview/renderers/tools/panel/PanelTaskTool
 */

import { useRef, useEffect } from 'react';
import { CrispyMarkdown } from '../../CrispyMarkdown.js';
import { useToolEntry } from '../../../context/ToolRegistryContext.js';
import { useSessionStatus } from '../../../hooks/useSessionStatus.js';
import { ToolBadge } from '../shared/ToolBadge.js';
import { getToolMeta } from '../shared/tool-metadata.js';
import { extractResultText } from '../shared/tool-utils.js';
import { PanelStatusBar } from './PanelBashTool.js';
import { ToolPanelCard } from './ToolPanelCard.js';
import { isAgentInput } from '../../../../core/transcript.js';
import type { ToolInput } from '../../../../core/transcript.js';

const meta = getToolMeta('Task');

export function PanelTaskTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  const { channelState } = useSessionStatus();
  const tailRef = useRef<HTMLDivElement>(null);
  const prevChildCountRef = useRef(0);
  const hadResultRef = useRef(false);

  const isStreaming = channelState === 'streaming';

  if (!entry) return null;

  const input = isAgentInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { prompt: string; subagent_type: string; description: string })
    : null;

  const agentType = input?.subagent_type ?? 'agent';
  const description = input?.description ?? '';
  const prompt = input?.prompt ?? null;

  const resultText = extractResultText(entry.result?.content);
  const hasResult = !!(entry.result && resultText);
  const childCount = entry.childIds.length;

  // Auto-track: scroll the tail element into view when a new child appears
  // or the result materialises, but only during active streaming.
  useEffect(() => {
    const childAdded = childCount > prevChildCountRef.current;
    const resultAppeared = hasResult && !hadResultRef.current;
    prevChildCountRef.current = childCount;
    hadResultRef.current = hasResult;

    if (isStreaming && (childAdded || resultAppeared)) {
      tailRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [childCount, hasResult, isStreaming]);

  return (
    <div className={`crispy-panel-card ${entry.status === 'error' ? 'crispy-panel-card--error' : ''}`}>
      {/* Header */}
      <div className="crispy-panel-card__header">
        <span className="crispy-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.badgeColor} label={agentType} />
        <span className="crispy-panel-card__description">{description}</span>
        <PanelStatusBar status={entry.status} />
      </div>

      {/* Prompt — plain markdown, first child after header */}
      {prompt && (
        <div className="prose user-text crispy-task-prompt crispy-panel-card__task-prompt">
          <CrispyMarkdown>{prompt}</CrispyMarkdown>
        </div>
      )}

      {/* Nested child tools — rendered via panel dispatch */}
      {childCount > 0 && (
        <div className="crispy-panel-card__children">
          {entry.childIds.map(childId => (
            <ToolPanelCard key={childId} toolId={childId} />
          ))}
        </div>
      )}

      {/* Result — last child, rendered inline like the children above */}
      {hasResult && (
        <div className={`prose assistant-text crispy-task-result crispy-panel-card__task-result ${entry.result!.is_error ? 'crispy-panel-card__output--error' : ''}`}>
          <CrispyMarkdown>{resultText!}</CrispyMarkdown>
        </div>
      )}

      {/* Invisible scroll anchor — always the last element in the card */}
      <div ref={tailRef} aria-hidden />
    </div>
  );
}
