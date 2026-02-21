/**
 * EnterPlanMode Tool Views — compact-only renderer for EnterPlanMode tool
 *
 * Shows "Planning mode" label with Entered/Denied status.
 * No expanded view needed — input is always empty {}.
 * Suppresses the empty YAML dump that the generic view would show.
 *
 * @module webview/blocks/views/enterplanmode-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';

const meta = getToolData('EnterPlanMode');

// ============================================================================
// Compact View
// ============================================================================

export function EnterPlanModeCompactView({ result, status }: ToolViewProps): ReactNode {
  const resultSummary = result
    ? result.is_error
      ? 'Denied'
      : 'Entered'
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label="EnterPlanMode" />
      <span className="crispy-blocks-compact-description">Planning mode</span>
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}
