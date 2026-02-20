/**
 * Grep Tool Views — custom renderers for Grep tool
 *
 * - Compact: pattern + scope + match count
 * - Expanded: pattern + scope + match results
 *
 * @module webview/blocks/views/grep-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';

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
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} textColor="#1e1e1e" label="Grep" />
      <span className="u-mono-pill crispy-tool-secondary">{pattern}</span>
      {scope && <span className="crispy-blocks-compact-description">in {scope}</span>}
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function GrepExpandedView({ block, result, status }: ToolViewProps): ReactNode {
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
    <details className="crispy-blocks-tool-card" open>
      <summary className="crispy-blocks-tool-summary">
        <span className="crispy-blocks-tool-header">
          <span className="crispy-blocks-tool-icon">{meta.icon}</span>
          <ToolBadge color={meta.color} textColor="#1e1e1e" label="Grep" />
          <span className="u-mono-pill crispy-tool-secondary">{pattern}</span>
          {scope && <span className="crispy-blocks-tool-description">in {scope}</span>}
        </span>
        <StatusIndicator status={status} summary={resultSummary} />
      </summary>
      {result && (
        <div className="crispy-blocks-tool-body">
          <pre className={`crispy-tool-result__text ${result.is_error ? 'crispy-tool-result__text--error' : ''}`}>
            {resultText ?? JSON.stringify(result.content, null, 2)}
          </pre>
        </div>
      )}
    </details>
  );
}
