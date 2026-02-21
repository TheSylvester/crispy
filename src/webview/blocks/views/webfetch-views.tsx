/**
 * WebFetch Tool Views — custom renderers for WebFetch tool
 *
 * - Compact: icon + badge + truncated URL as subject + status
 * - Expanded: truncated URL in header, prompt as description, result as markdown
 *
 * @module webview/blocks/views/webfetch-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { CrispyMarkdown } from '../../renderers/CrispyMarkdown.js';
import { ToolCard } from './ToolCard.js';

const meta = getToolData('WebFetch');

interface WebFetchInput {
  url?: string;
  prompt?: string;
}

function truncateUrl(url: string, maxLen = 60): string {
  return url.length > maxLen ? url.slice(0, maxLen) + '\u2026' : url;
}

// ============================================================================
// Compact View
// ============================================================================

export function WebFetchCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as WebFetchInput;
  const url = input.url ?? '(unknown)';

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label="WebFetch" />
      <span className="crispy-blocks-compact-subject">{truncateUrl(url)}</span>
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function WebFetchExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as WebFetchInput;
  const url = input.url ?? '(unknown)';
  const prompt = input.prompt ?? null;

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="WebFetch" />
        <span className="u-mono-pill crispy-tool-secondary">{truncateUrl(url)}</span>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      <div className="crispy-blocks-tool-body">
        {prompt && (
          <div className="crispy-tool-description">{prompt}</div>
        )}
        {result && resultText && (
          <div className={`prose assistant-text crispy-task-result ${result.is_error ? 'crispy-task-result--error' : ''}`}>
            <CrispyMarkdown>{resultText}</CrispyMarkdown>
          </div>
        )}
      </div>
    </ToolCard>
  );
}
