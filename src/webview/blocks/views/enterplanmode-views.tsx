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
import { CompactBlock } from './default-views.js';

const meta = getToolData('EnterPlanMode');

// ============================================================================
// Compact View
// ============================================================================

export function EnterPlanModeCompactView({ result, status }: ToolViewProps): ReactNode {
  return (
    <CompactBlock
      icon={meta.icon}
      color={meta.color}
      name="EnterPlanMode"
      subject="Planning mode"
      status={status}
    />
  );
}
