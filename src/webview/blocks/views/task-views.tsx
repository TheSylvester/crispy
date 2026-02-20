/**
 * Task Tool Views — custom renderers for Task (sub-agent) tool
 *
 * - Compact: agent type badge + description + child count
 * - Expanded: prompt + nested children + result
 *
 * Task is special: it renders its children recursively using the blocks
 * pipeline. Children are tool_use blocks with parentToolUseId matching
 * this task's block.id.
 *
 * @module webview/blocks/views/task-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { CrispyMarkdown } from '../../renderers/CrispyMarkdown.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';

const meta = getToolData('Task');

interface TaskInput {
  prompt?: string;
  subagent_type?: string;
  description?: string;
}

// ============================================================================
// Compact View
// ============================================================================

export function TaskCompactView({ block, result, status, children }: ToolViewProps): ReactNode {
  const input = block.input as TaskInput;
  const agentType = input.subagent_type ?? 'agent';
  const description = input.description ?? '';

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <div className="crispy-blocks-task-compact">
      <div className="crispy-blocks-compact-row">
        <span className="crispy-blocks-compact-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label={agentType} />
        <span className="crispy-blocks-compact-description">{description}</span>
        <StatusIndicator status={status} summary={resultSummary} />
      </div>
      {children}
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

/**
 * Task expanded view.
 *
 * Children are rendered inside the card body between the prompt and result,
 * using the same blocks pipeline recursively. The ToolBlockRenderer passes
 * rendered children via props.children (from useBlocksChildEntries).
 */
export function TaskExpandedView({ block, result, status, children }: ToolViewProps): ReactNode {
  const input = block.input as TaskInput;
  const agentType = input.subagent_type ?? 'agent';
  const description = input.description ?? '';
  const prompt = input.prompt ?? null;

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <details className="crispy-blocks-tool-card crispy-blocks-task-card" open>
      <summary className="crispy-blocks-tool-summary">
        <span className="crispy-blocks-tool-header">
          <span className="crispy-blocks-tool-icon">{meta.icon}</span>
          <ToolBadge color={meta.color} label={agentType} />
          <span className="crispy-blocks-tool-description">{description}</span>
        </span>
        <StatusIndicator status={status} summary={resultSummary} />
      </summary>
      <div className="crispy-blocks-tool-body">
        {/* Initial prompt — rendered as user-style message */}
        {prompt && (
          <div className="prose user-text crispy-task-prompt">
            <CrispyMarkdown>{prompt}</CrispyMarkdown>
          </div>
        )}

        {/* Child entries — sub-agent tools rendered recursively */}
        {children}

        {/* Result output — rich markdown rendering */}
        {result && resultText && (
          <div className={`prose assistant-text crispy-task-result ${result.is_error ? 'crispy-task-result--error' : ''}`}>
            <CrispyMarkdown>{resultText}</CrispyMarkdown>
          </div>
        )}
      </div>
    </details>
  );
}
