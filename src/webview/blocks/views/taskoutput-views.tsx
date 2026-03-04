/**
 * TaskOutput Tool Views — compact and expanded renderers for TaskOutput tool
 *
 * - Compact: 🤖 icon + "task-output" badge + task_id subject + blocking badge + status
 * - Expanded: ToolCard with same header; body renders XML metadata as key-value
 *   pairs (polling responses) or rich markdown via CrispyMarkdown (completed output)
 *
 * @module webview/blocks/views/taskoutput-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { CrispyMarkdown } from '../../renderers/CrispyMarkdown.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';

const meta = getToolData('TaskOutput');

interface TaskOutputInput {
  task_id?: string;
  block?: boolean;
  timeout?: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Try to parse XML-like `<tag>value</tag>` pairs from TaskOutput status responses.
 * Returns key-value pairs if the text is predominantly XML metadata, null otherwise.
 */
const TAG_RE = /<(\w+)>([\s\S]*?)<\/\1>/g;

function parseXmlMetadata(text: string): [string, string][] | null {
  const pairs: [string, string][] = [];
  let totalTagLength = 0;
  let match;

  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(text)) !== null) {
    pairs.push([match[1], match[2].trim()]);
    totalTagLength += match[0].length;
  }

  if (pairs.length === 0) return null;

  // Only treat as XML metadata if tags account for the bulk of the content
  // (non-tag leftovers are just whitespace/newlines)
  const leftover = text.trim().length - totalTagLength;
  if (leftover > text.trim().length * 0.3) return null;

  return pairs;
}

// ============================================================================
// Compact View
// ============================================================================

export function TaskOutputCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as TaskOutputInput;
  const taskId = input.task_id ?? '';
  const isBlocking = input.block !== false;

  const resultText = extractResultText(result?.content);

  // For compact summary, pull status from XML metadata if available
  let resultSummary: string | undefined;
  if (result) {
    if (result.is_error) {
      resultSummary = 'Failed';
    } else if (resultText) {
      const xmlPairs = parseXmlMetadata(resultText);
      const statusValue = xmlPairs?.find(([k]) => k === 'status')?.[1];
      resultSummary = statusValue ?? formatCount(resultText, 'line');
    }
  }

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label="task-output" />
      {isBlocking && <ToolBadge color="var(--vscode-badge-background, #666)" label="blocking" />}
      {taskId && <span className="crispy-blocks-compact-subject">{taskId}</span>}
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function TaskOutputExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as TaskOutputInput;
  const taskId = input.task_id ?? '';
  const isBlocking = input.block !== false;

  const resultText = extractResultText(result?.content);
  const xmlPairs = resultText ? parseXmlMetadata(resultText) : null;

  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : xmlPairs
        ? (xmlPairs.find(([k]) => k === 'status')?.[1] ?? `${xmlPairs.length} fields`)
        : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="task-output" />
        {isBlocking && <ToolBadge color="var(--vscode-badge-background, #666)" label="blocking" />}
        {taskId && <span className="crispy-blocks-tool-description">{taskId}</span>}
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {result && resultText && (
        xmlPairs ? (
          <div className="crispy-blocks-tool-body crispy-blocks-taskoutput-metadata">
            {xmlPairs.map(([key, value]) => (
              <div key={key} className="crispy-blocks-taskoutput-row">
                <span className="crispy-blocks-taskoutput-key">{key}</span>
                <span className="crispy-blocks-taskoutput-value">{value}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className={`prose assistant-text crispy-task-result ${result.is_error ? 'crispy-task-result--error' : ''}`}>
            <CrispyMarkdown>{resultText}</CrispyMarkdown>
          </div>
        )
      )}
      {result && !resultText && input.timeout != null && (
        <div className="crispy-blocks-tool-body">
          <span className="crispy-blocks-compact-subject">timeout: {input.timeout}ms</span>
        </div>
      )}
    </ToolCard>
  );
}
