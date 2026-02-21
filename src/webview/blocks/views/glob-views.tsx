/**
 * Glob Tool Views — custom renderers for Glob tool
 *
 * - Compact: pattern + search path + file count
 * - Expanded: pattern + search path + file matches
 *
 * @module webview/blocks/views/glob-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';

const meta = getToolData('Glob');

interface GlobInput {
  pattern?: string;
  path?: string;
}

// ============================================================================
// Compact View
// ============================================================================

export function GlobCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as GlobInput;
  const pattern = input.pattern ?? '(unknown)';
  const searchPath = input.path;

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : formatCount(resultText, 'file', true)
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label="Glob" />
      <span className="u-mono-pill crispy-tool-secondary">{pattern}</span>
      {searchPath && <span className="crispy-blocks-compact-description">in {searchPath}</span>}
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function GlobExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as GlobInput;
  const pattern = input.pattern ?? '(unknown)';
  const searchPath = input.path;

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : formatCount(resultText, 'file', true)
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="Glob" />
        <span className="u-mono-pill crispy-tool-secondary">{pattern}</span>
        {searchPath && <span className="crispy-blocks-tool-description">in {searchPath}</span>}
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
