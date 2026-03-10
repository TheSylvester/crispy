/**
 * Grep Tool Views — custom renderers for Grep tool
 *
 * - Compact: dot-line with colored "grep" + pattern + status
 * - Expanded: pattern + scope + match results
 *
 * @module webview/blocks/views/grep-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData, extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';
import { CompactBlock } from './default-views.js';

const meta = getToolData('Grep');

interface GrepInput {
  pattern?: string;
  path?: string;
  glob?: string;
  type?: string;
}

// ============================================================================
// Compact View
// ============================================================================

export function GrepCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const subject = extractSubject(block);

  return (
    <CompactBlock
      icon={meta.icon}
      color={meta.color}
      name="grep"
      subject={subject}
      status={status}
    />
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function GrepExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as GrepInput;
  const pattern = input.pattern ?? '(unknown)';
  const scope = input.path ?? input.glob ?? input.type;

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : formatCount(resultText, 'match', true)
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="Grep" />
        <span className="u-mono-pill crispy-tool-secondary">{pattern}</span>
        {scope && <span className="crispy-blocks-tool-description">in {scope}</span>}
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
