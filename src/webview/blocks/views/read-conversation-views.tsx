/**
 * Read Conversation Views — custom renderers for mcp__memory__read_conversation
 *
 * - Compact: dot-line with colored "read_conversation" + session ID + status
 * - Expanded: session ID in header, transcript content in body
 *
 * @module webview/blocks/views/read-conversation-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';
import { CrispyMarkdown } from '../../renderers/CrispyMarkdown.js';
import { CompactBlock } from './default-views.js';

const meta = getToolData('mcp__memory__read_conversation');

interface ReadConversationInput {
  sessionId?: string;
  sessionFile?: string;
  tail?: number;
  offset?: number;
  limit?: number;
  budget?: number;
}

/** Short display label for the session — prefix or filename. */
function sessionLabel(input: ReadConversationInput): string {
  if (input.sessionId) {
    // Show first 8 chars of UUID for brevity
    return input.sessionId.length > 8
      ? input.sessionId.slice(0, 8) + '…'
      : input.sessionId;
  }
  if (input.sessionFile) {
    const parts = input.sessionFile.split('/');
    return parts[parts.length - 1] ?? input.sessionFile;
  }
  return '(unknown)';
}

/** Build a parenthetical hint from pagination params. */
function paginationHint(input: ReadConversationInput): string | null {
  const parts: string[] = [];
  if (input.tail != null) parts.push(`tail ${input.tail}`);
  if (input.offset != null) parts.push(`offset ${input.offset}`);
  if (input.limit != null) parts.push(`limit ${input.limit}`);
  if (input.budget != null) parts.push(`budget ${input.budget}`);
  return parts.length ? parts.join(', ') : null;
}

// ============================================================================
// Compact View
// ============================================================================

export function ReadConversationCompactView({ block, status }: ToolViewProps): ReactNode {
  const input = block.input as ReadConversationInput;
  const label = sessionLabel(input);

  return (
    <CompactBlock
      icon={meta.icon}
      color={meta.color}
      name="read_conversation"
      subject={label}
      status={status}
    />
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function ReadConversationExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as ReadConversationInput;
  const label = sessionLabel(input);
  const hint = paginationHint(input);

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : resultText
        ? formatCount(resultText, 'line')
        : 'No content'
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="read_conversation" />
        <span className="u-mono-pill crispy-tool-secondary">{label}</span>
        {hint && <span className="crispy-tool-secondary crispy-tool-dim">({hint})</span>}
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {result && (
        <div className="crispy-blocks-tool-body">
          {result.is_error ? (
            <pre className="crispy-tool-result__text crispy-tool-result__text--error">
              {resultText ?? JSON.stringify(result.content, null, 2)}
            </pre>
          ) : resultText ? (
            <CrispyMarkdown>{resultText}</CrispyMarkdown>
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
