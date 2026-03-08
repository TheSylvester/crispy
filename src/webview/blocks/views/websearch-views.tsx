/**
 * WebSearch Tool Views — custom renderers for WebSearch tool
 *
 * - Compact: dot-line with colored "websearch" + query + status
 * - Expanded: query in header, result as <pre>
 *
 * @module webview/blocks/views/websearch-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData, extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';
import { DotLine, DotLineStatus } from './default-views.js';

const meta = getToolData('WebSearch');

interface WebSearchInput {
  query?: string;
}

// ============================================================================
// Compact View
// ============================================================================

export function WebSearchCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const subject = extractSubject(block);

  return (
    <DotLine
      icon={meta.icon}
      color={meta.color}
      name="websearch"
      subject={subject}
      result={<DotLineStatus status={status} />}
    />
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function WebSearchExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as WebSearchInput;
  const query = input.query ?? '(unknown)';

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
        <ToolBadge color={meta.color} label="WebSearch" />
        <span className="u-mono-pill crispy-tool-secondary">{query}</span>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {result && (
        <div className="crispy-blocks-tool-body">
          <pre className={`crispy-tool-result__text ${result.is_error ? 'crispy-tool-result__text--error' : ''}`}>
            {resultText ?? JSON.stringify(result.content, null, 2)}
          </pre>
        </div>
      )}
    </ToolCard>
  );
}
