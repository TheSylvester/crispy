/**
 * Write Tool Views — custom renderers for Write tool
 *
 * - Expanded: file path + line count + code preview
 *
 * @module webview/blocks/views/write-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { FilePath } from '../../renderers/tools/shared/FilePath.js';
import { CodePreview } from '../../renderers/tools/shared/CodePreview.js';
import { inferLanguage } from '../../renderers/tools/shared/tool-utils.js';

const meta = getToolData('Write');

interface WriteInput {
  file_path?: string;
  content?: string;
}

// ============================================================================
// Compact View
// ============================================================================

export function WriteCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as WriteInput;
  const filePath = input.file_path ?? '(unknown)';
  const content = input.content ?? '';
  const lineCount = content.split('\n').length;

  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : 'Written'
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label="Write" />
      <FilePath path={filePath} />
      <span className="crispy-tool-line-info">({lineCount} lines)</span>
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function WriteExpandedView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as WriteInput;
  const filePath = input.file_path ?? '(unknown)';
  const content = input.content ?? '';
  const lineCount = content.split('\n').length;
  const lang = inferLanguage(filePath);

  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : 'Written'
    : undefined;

  return (
    <details className="crispy-blocks-tool-card" open>
      <summary className="crispy-blocks-tool-summary">
        <span className="crispy-blocks-tool-header">
          <span className="crispy-blocks-tool-icon">{meta.icon}</span>
          <ToolBadge color={meta.color} label="Write" />
          <FilePath path={filePath} />
          <span className="crispy-tool-line-info">({lineCount} lines)</span>
        </span>
        <StatusIndicator status={status} summary={resultSummary} />
      </summary>
      <div className="crispy-blocks-tool-body">
        {content && <CodePreview code={content} language={lang} />}
        {result && result.is_error && (
          <pre className="crispy-tool-result__text crispy-tool-result__text--error">
            {typeof result.content === 'string'
              ? result.content
              : JSON.stringify(result.content, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}
