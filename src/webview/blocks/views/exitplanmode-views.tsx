/**
 * ExitPlanMode Tool Views — compact + expanded renderers
 *
 * - Compact: dot-line with colored "exitplanmode" + plan info + status
 * - Expanded: ToolCard with plan as markdown (collapsed) + permissions list
 *
 * @module webview/blocks/views/exitplanmode-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { CrispyMarkdown } from '../../renderers/CrispyMarkdown.js';
import { ToolCard } from './ToolCard.js';
import { CompactBlock } from './default-views.js';

const meta = getToolData('ExitPlanMode');

interface ExitPlanInput {
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  plan?: string;
}

// ============================================================================
// Compact View
// ============================================================================

export function ExitPlanModeCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as ExitPlanInput;
  const permCount = input.allowedPrompts?.length ?? 0;

  const description = permCount > 0
    ? `Plan Ready (${permCount} permission${permCount !== 1 ? 's' : ''})`
    : 'Plan Ready';

  return (
    <CompactBlock
      icon={meta.icon}
      color={meta.color}
      name="exitplanmode"
      subject={description}
      status={status}
    />
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function ExitPlanModeExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as ExitPlanInput;
  const plan = input.plan ?? null;
  const allowedPrompts = input.allowedPrompts ?? null;
  const permCount = allowedPrompts?.length ?? 0;

  const resultSummary = result
    ? result.is_error
      ? 'Rejected'
      : 'Approved'
    : undefined;

  const description = permCount > 0
    ? `Plan Ready (${permCount} permission${permCount !== 1 ? 's' : ''})`
    : 'Plan Ready';

  return (
    <ToolCard anchor={anchor} open={true} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="ExitPlanMode" />
        <span className="crispy-blocks-tool-description">{description}</span>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      <div className="crispy-blocks-tool-body">
        {plan && (
          <details className="crispy-plan-details">
            <summary className="crispy-plan-summary">View plan</summary>
            <div className="prose assistant-text crispy-task-result">
              <CrispyMarkdown>{plan}</CrispyMarkdown>
            </div>
          </details>
        )}
        {allowedPrompts && allowedPrompts.length > 0 && (
          <div className="crispy-plan-permissions">
            <div className="crispy-plan-permissions__title">Requested permissions:</div>
            <ul className="crispy-plan-permissions-list">
              {allowedPrompts.map((p, i) => (
                <li key={i}>
                  <code className="u-mono-pill crispy-plan-permission__tool">{p.tool}</code>
                  <span className="crispy-plan-permission__prompt"> — {p.prompt}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ToolCard>
  );
}
