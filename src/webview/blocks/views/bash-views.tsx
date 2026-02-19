/**
 * Bash Tool Views — custom renderers for Bash tool
 *
 * - Compact: command preview + exit status
 * - Expanded: full command + stdout/stderr output
 *
 * @module webview/blocks/views/bash-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';

const meta = getToolData('Bash');

interface BashInput {
  command?: string;
  description?: string;
  timeout?: number;
}

// ============================================================================
// Compact View
// ============================================================================

export function BashCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as BashInput;
  const command = input.command ?? '';
  const firstLine = command.split('\n')[0];
  const truncated = firstLine.length > 60 ? firstLine.slice(0, 59) + '…' : firstLine;

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} textColor="#1e1e1e" label="Bash" />
      {input.description && (
        <span className="crispy-blocks-compact-description">{input.description}</span>
      )}
      <code className="crispy-blocks-bash-command">{truncated}</code>
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function BashExpandedView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as BashInput;
  const command = input.command ?? '';

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <details className="crispy-blocks-tool-card" open>
      <summary className="crispy-blocks-tool-summary">
        <span className="crispy-blocks-tool-header">
          <span className="crispy-blocks-tool-icon">{meta.icon}</span>
          <ToolBadge color={meta.color} textColor="#1e1e1e" label="Bash" />
          {input.description && (
            <span className="crispy-blocks-tool-description">{input.description}</span>
          )}
          <code className="u-mono-pill crispy-tool-bash-inline">{command}</code>
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
