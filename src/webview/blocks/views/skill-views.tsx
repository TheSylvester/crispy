/**
 * Skill Tool Views — compact renderer for Skill tool
 *
 * Shows skill name as badge (not generic "Skill") + args as description.
 *
 * @module webview/blocks/views/skill-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';

const meta = getToolData('Skill');

interface SkillInput {
  skill?: string;
  args?: string;
}

export function SkillCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as SkillInput;
  const skillName = input.skill ?? 'skill';
  const args = input.args ?? null;

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label={skillName} />
      {args && <span className="crispy-blocks-compact-description">{args}</span>}
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}
