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

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock, PreBlock } from '../markdown-components.js';
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
  const prompt = input?.prompt ?? null;

  // Result text — content can be a string or array of text blocks
  const resultText = extractResultText(entry.result?.content);
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Failed' : formatLineCount(resultText)
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={'\uD83E\uDD16'}
      badgeColor="#64748b"
      badgeLabel={agentType}
      defaultOpen={true}
      resultSummary={resultSummary}
      headerContent={
        <span className="crispy-tool-description">{description}</span>
      }
    >
      {/* Initial prompt — rendered as user-style message */}
      {prompt && (
        <div className="prose user-text crispy-task-prompt">
          <Markdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock, pre: PreBlock }}>
            {prompt}
          </Markdown>
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
          <Markdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock, pre: PreBlock }}>
            {resultText}
          </Markdown>
        </div>
      )}
    </ToolCardShell>
  );
}

/** Extract display text from tool_result content (string or array of text blocks). */
function extractResultText(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null && 'text' in b && typeof b.text === 'string')
      .map((b) => b.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

function formatLineCount(text: string | null): string {
  if (!text) return '';
  const lines = text.split('\n').length;
  return `${lines} line${lines !== 1 ? 's' : ''}`;
}
