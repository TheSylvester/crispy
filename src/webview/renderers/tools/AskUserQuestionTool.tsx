/**
 * AskUserQuestion Tool Renderer
 *
 * Shows questions with their options in the transcript.
 * Expanded by default — provides context for what was asked.
 * The interactive approval UI is separate (in ApprovalContent);
 * this renderer is for the post-resolution transcript view.
 *
 * @module webview/renderers/tools/AskUserQuestionTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { getToolMeta } from './shared/tool-metadata.js';
import { isAskUserQuestionInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

const meta = getToolMeta('AskUserQuestion');

interface Question {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: Array<{
    label: string;
    description?: string;
  }>;
}

export function AskUserQuestionTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isAskUserQuestionInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { questions: Question[] })
    : null;

  const questions = input?.questions ?? [];
  const firstHeader = questions[0]?.header ?? 'Question';

  // Result summary
  const resultSummary = entry.result
    ? entry.result.is_error ? 'Denied' : 'Answered'
    : undefined;

  return (
    <ToolCardShell
      toolId={toolId}
      icon={meta.icon}
      badgeColor={meta.badgeColor}
      badgeLabel="Ask User Question"
      defaultOpen={true}
      resultSummary={resultSummary}
      headerContent={
        <span className="crispy-tool-description">{firstHeader}</span>
      }
    >
      {questions.length > 0 && (
        <div className="crispy-askuser-questions">
          {questions.map((q, i) => (
            <div key={i} className="crispy-askuser-question">
              <strong className="crispy-askuser-question__text">{q.question}</strong>
              {q.options.length > 0 && (
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
    </ToolCardShell>
  );
}
