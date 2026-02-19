/**
 * Read Tool Views — custom renderers for Read tool
 *
 * - Expanded: file path + line range + file content
 *
 * @module webview/blocks/views/read-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { FilePath } from '../../renderers/tools/shared/FilePath.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';

const meta = getToolData('Read');

interface ReadInput {
  file_path?: string;
  offset?: number;
  limit?: number;
}

// ============================================================================
// Expanded View
// ============================================================================

export function ReadExpandedView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as ReadInput;
  const filePath = input.file_path ?? '(unknown)';

  // Compute line range string
  let lineRange: string | undefined;
  if (input.offset != null || input.limit != null) {
    const start = (input.offset ?? 0) + 1;
    if (input.limit != null) {
      lineRange = `:${start}-${start + input.limit - 1}`;
    } else {
      lineRange = `:${start}+`;
    }
  }

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Not found'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <details className="crispy-blocks-tool-card" open>
      <summary className="crispy-blocks-tool-summary">
        <span className="crispy-blocks-tool-header">
          <span className="crispy-blocks-tool-icon">{meta.icon}</span>
          <ToolBadge color={meta.color} label="Read" />
          <FilePath path={filePath} lineRange={lineRange} />
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
