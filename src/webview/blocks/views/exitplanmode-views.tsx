/**
 * ExitPlanMode Tool Views — compact renderer for ExitPlanMode tool
 *
 * Shows "Plan Ready" + permission count + Approved/Rejected status.
 *
 * @module webview/blocks/views/exitplanmode-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';

const meta = getToolData('ExitPlanMode');

interface ExitPlanInput {
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
}

export function ExitPlanModeCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as ExitPlanInput;
  const permCount = input.allowedPrompts?.length ?? 0;

  const resultSummary = result
    ? result.is_error
      ? 'Rejected'
      : 'Approved'
    : undefined;

  const description = permCount > 0
    ? `Plan Ready (${permCount} permission${permCount !== 1 ? 's' : ''})`
    : 'Plan Ready';

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label="ExitPlanMode" />
      <span className="crispy-blocks-compact-description">{description}</span>
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}
