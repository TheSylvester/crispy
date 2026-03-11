/**
 * Recall Tool Views — custom renderers for mcp__memory__recall_conversations
 *
 * - Compact: dot-line with colored "recall" + query + status
 * - Expanded: query in header, cleaned markdown response in body
 *
 * @module webview/blocks/views/recall-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData, extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';
import { CrispyMarkdown } from '../../renderers/CrispyMarkdown.js';
import { CompactBlock } from './default-views.js';

const meta = getToolData('mcp__memory__recall_conversations');

interface RecallInput {
  query?: string;
}

/**
 * Strip internal MCP sub-call XML from recall agent output.
 * These are implementation details that shouldn't be shown to the user.
 */
function stripInternalCalls(text: string): string {
  return text
    .replace(/\n?<function_calls>[\s\S]*?<\/function_calls>\n?/g, '')
    .replace(/\n?<invoke[\s\S]*?<\/invoke>\n?/g, '')
    .trim();
}

// ============================================================================
// Compact View
// ============================================================================

export function RecallCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const subject = extractSubject(block);

  return (
    <CompactBlock
      icon={meta.icon}
      color={meta.color}
      name="recall"
      subject={subject}
      status={status}
    />
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function RecallExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as RecallInput;
  const query = input.query ?? '(unknown)';

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : resultText
        ? formatCount(resultText, 'line')
        : 'No results'
    : undefined;

  const cleanedText = resultText ? stripInternalCalls(resultText) : null;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="recall" />
        <span className="u-mono-pill crispy-tool-secondary">{query}</span>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {result && (
        <div className="crispy-blocks-tool-body">
          {result.is_error ? (
            <pre className="crispy-tool-result__text crispy-tool-result__text--error">
              {resultText ?? JSON.stringify(result.content, null, 2)}
            </pre>
          ) : cleanedText ? (
            <CrispyMarkdown>{cleanedText}</CrispyMarkdown>
          ) : (
            <pre className="crispy-tool-result__text">
              {JSON.stringify(result.content, null, 2)}
            </pre>
          )}
        </div>
      )}
    </ToolCard>
  );
}
