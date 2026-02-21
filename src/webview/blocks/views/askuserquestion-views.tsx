/**
 * AskUserQuestion Tool Views — compact + expanded renderers
 *
 * - Compact: first question header + Answered/Denied status
 * - Expanded: ToolCard with questions list and their options
 *
 * @module webview/blocks/views/askuserquestion-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { ToolCard } from './ToolCard.js';

const meta = getToolData('AskUserQuestion');

interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{
      label: string;
      description?: string;
    }>;
  }>;
}

// ============================================================================
// Compact View
// ============================================================================

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

// ============================================================================
// Expanded View
// ============================================================================

export function AskUserQuestionExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as AskUserQuestionInput;
  const questions = input.questions ?? [];
  const firstHeader = questions[0]?.header ?? 'Question';

  const count = questions.length;
  const resultSummary = result
    ? result.is_error
      ? 'Denied'
      : `${count} answered`
    : undefined;

  return (
    <ToolCard anchor={anchor} open={true} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="AskUserQuestion" />
        <span className="crispy-blocks-tool-description">{firstHeader}</span>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {questions.length > 0 && (
        <div className="crispy-askuser-questions">
          {questions.map((q, i) => (
            <div key={i} className="crispy-askuser-question">
              <strong className="crispy-askuser-question__text">{q.question}</strong>
              {q.options && q.options.length > 0 && (
                <ul className="crispy-askuser-options">
                  {q.options.map((opt, j) => (
                    <li key={j} className="crispy-askuser-option">
                      <span className="crispy-askuser-option__label">{opt.label}</span>
                      {opt.description && (
                        <span className="crispy-askuser-option__desc"> — {opt.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </ToolCard>
  );
}
