/**
 * Bash Tool Views — custom renderers for Bash tool
 *
 * - Compact: dot-line with colored "bash" + command as subject + status
 * - Expanded: full command + stdout/stderr output
 *
 * @module webview/blocks/views/bash-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData, extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, extractRawResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { renderAnsi, hasAnsi } from '../../renderers/tools/shared/ansi.js';
import { useThemeKind, isLightTheme } from '../../hooks/useThemeKind.js';
import { ToolCard } from './ToolCard.js';
import { DotLine, DotLineStatus } from './default-views.js';

const meta = getToolData('Bash');

interface BashInput {
  command?: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

/** Convert ms timeout to compact label: "30s", "2min", "10min" */
function formatTimeout(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}min`;
}

// ============================================================================
// Compact View (expanded header without collapsible body)
// ============================================================================

export function BashCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as BashInput;
  const command = input.command ?? '';

  return (
    <div className="crispy-blocks-bash-compact">
      <div className="crispy-blocks-compact-row">
        <span className="crispy-blocks-compact-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="Bash" />
        {input.run_in_background && (
          <ToolBadge color="var(--vscode-badge-background, #666)" label="background" />
        )}
        {input.timeout != null && (
          <ToolBadge color="var(--vscode-badge-background, #666)" label={`\u23F1 ${formatTimeout(input.timeout)}`} />
        )}
        {input.description && (
          <span className="crispy-blocks-tool-description">{input.description}</span>
        )}
        <DotLineStatus status={status} />
      </div>
      {command && (
        <code className="u-mono-pill crispy-tool-bash-inline crispy-tool-bash-inline--compact">{command}</code>
      )}
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function BashExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as BashInput;
  const command = input.command ?? '';

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : formatCount(resultText, 'line')
    : undefined;

  // Use raw text (with ANSI codes) for colored rendering
  const rawText = extractRawResultText(result?.content);
  const useAnsiRender = rawText !== null && hasAnsi(rawText);

  const themeKind = useThemeKind();
  const light = isLightTheme(themeKind);

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="Bash" />
        {input.run_in_background && (
          <ToolBadge color="var(--vscode-badge-background, #666)" label="background" />
        )}
        {input.timeout != null && (
          <ToolBadge color="var(--vscode-badge-background, #666)" label={`\u23F1 ${formatTimeout(input.timeout)}`} />
        )}
        {input.description && (
          <span className="crispy-blocks-tool-description">{input.description}</span>
        )}
        <code className="u-mono-pill crispy-tool-bash-inline">{command}</code>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {result && (
        <div className="crispy-blocks-tool-body">
          <pre className={`crispy-blocks-bash-output ${result.is_error ? 'crispy-tool-result__text--error' : ''}`}>
            {useAnsiRender ? renderAnsi(rawText!, light) : (resultText ?? JSON.stringify(result.content, null, 2))}
          </pre>
        </div>
      )}
    </ToolCard>
  );
}
