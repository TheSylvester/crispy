/**
 * Skill Tool Views — compact and expanded renderers for Skill tool
 *
 * - Compact: dot-line with colored skill name + status
 * - Expanded: skill name badge + markdown-rendered result
 *
 * @module webview/blocks/views/skill-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData, extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { CrispyMarkdown } from '../../renderers/CrispyMarkdown.js';
import { extractResultText, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ToolCard } from './ToolCard.js';
import { CompactBlock } from './default-views.js';

const meta = getToolData('Skill');

interface SkillInput {
  skill?: string;
  args?: string;
}

// ============================================================================
// Compact View
// ============================================================================

export function SkillCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as SkillInput;
  const skillName = input.skill ?? 'skill';

  return (
    <CompactBlock
      icon={meta.icon}
      color={meta.color}
      name="skill"
      subject={skillName}
      status={status}
    />
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function SkillExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as SkillInput;
  const skillName = input.skill ?? 'skill';

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Failed'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label={skillName} />
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {result && resultText && (
        <div className={`prose assistant-text crispy-task-result ${result.is_error ? 'crispy-task-result--error' : ''}`}>
          <CrispyMarkdown>{resultText}</CrispyMarkdown>
        </div>
      )}
    </ToolCard>
  );
}
