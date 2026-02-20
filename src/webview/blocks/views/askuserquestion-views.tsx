/**
 * AskUserQuestion Tool Views — compact renderer for AskUserQuestion tool
 *
 * Shows first question header + Answered/Denied status.
 *
 * @module webview/blocks/views/askuserquestion-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';

const meta = getToolData('AskUserQuestion');

interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
  }>;
}

export function AskUserQuestionCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as AskUserQuestionInput;
  const questions = input.questions ?? [];
  const count = questions.length;
  const firstHeader = questions[0]?.header ?? null;

  const resultSummary = result
    ? result.is_error
      ? 'Denied'
      : `${count} answered`
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label="AskUserQuestion" />
      {firstHeader && <span className="crispy-blocks-compact-description">{firstHeader}</span>}
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}
