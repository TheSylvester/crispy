/**
 * AskUserApproval — structured approval UI for AskUserQuestion tool
 *
 * Renders question panels with radio/checkbox options, tab navigation
 * for multi-question flows, and a ChatInput for freeform "Other" answers.
 * Collects answers keyed by question text and resolves with updatedInput.
 *
 * @module approval/AskUserApproval
 */

import { useState } from 'react';
import type { AskUserQuestionInput, ApprovalExtra } from './types.js';
import { ChatInput } from '../control-panel/ChatInput.js';

interface AskUserApprovalProps {
  input: AskUserQuestionInput;
  onResolve: (optionId: string, extra?: ApprovalExtra) => void;
}

export function AskUserApproval({ input, onResolve }: AskUserApprovalProps): React.JSX.Element {
  const { questions } = input;
  const [activeTab, setActiveTab] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

  const isAnswered = (qIndex: number): boolean => {
    const answer = answers[qIndex];
    if (Array.isArray(answer)) return answer.length > 0;
    return !!answer;
  };
  const allAnswered = questions.every((_, i) => isAnswered(i));

  function handleOptionSelect(qIndex: number, label: string, multiSelect?: boolean): void {
    if (multiSelect) {
      setAnswers((prev) => {
        const current = Array.isArray(prev[qIndex]) ? (prev[qIndex] as string[]) : [];
        const updated = current.includes(label)
          ? current.filter((v) => v !== label)
          : [...current, label];
        return { ...prev, [qIndex]: updated };
      });
    } else {
      setAnswers((prev) => ({ ...prev, [qIndex]: label }));
    }
  }

  function handleSubmit(): void {
    const collectedAnswers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const answer = answers[i];
      if (Array.isArray(answer)) {
        // Multi-select: join array values, replacing "Other" with freeform text
        const text = otherTexts[i]?.trim();
        const resolved = answer.map((v) =>
          v === 'Other' ? (text ? `Other: ${text}` : 'Other') : v,
        );
        collectedAnswers[q.question] = resolved.join(', ');
      } else if (answer === 'Other') {
        const text = otherTexts[i]?.trim();
        collectedAnswers[q.question] = text ? `Other: ${text}` : 'Other';
      } else {
        collectedAnswers[q.question] = answer ?? '';
      }
    });
    onResolve('allow', { updatedInput: { answers: collectedAnswers } });
  }

  /** Whether the "Other" ChatInput is visible for the active tab. */
  function isOtherVisible(qIndex: number): boolean {
    const answer = answers[qIndex];
    if (Array.isArray(answer)) {
      return answer.includes('Other');
    }
    return answer === 'Other';
  }

  function renderQuestionPanel(qIndex: number): React.JSX.Element {
    const q = questions[qIndex];
    const currentAnswer = answers[qIndex];
    const isMulti = q.multiSelect === true;
    const selectedValues: string[] = isMulti
      ? (Array.isArray(currentAnswer) ? currentAnswer : [])
      : [];
    const currentString = typeof currentAnswer === 'string' ? currentAnswer : '';
    const otherSelected = isMulti
      ? selectedValues.includes('Other')
      : currentString === 'Other';

    return (
      <div key={qIndex}>
        <div className="crispy-approval-question">{q.question}</div>
        <div className="crispy-approval-options">
          {q.options.map((opt) => {
            const isSelected = isMulti
              ? selectedValues.includes(opt.label)
              : currentString === opt.label;

            return (
              <label
                key={opt.label}
                className={`crispy-approval-option ${isSelected ? 'crispy-approval-option--selected' : ''}`}
              >
                <input
                  type={isMulti ? 'checkbox' : 'radio'}
                  name={`q-${qIndex}`}
                  checked={isSelected}
                  onChange={() => handleOptionSelect(qIndex, opt.label, isMulti)}
                />
                <div>
                  <div className="crispy-approval-option__label">{opt.label}</div>
                  <div className="crispy-approval-option__desc">{opt.description}</div>
                </div>
              </label>
            );
          })}

          {/* "Other" option */}
          <label
            className={`crispy-approval-option ${otherSelected ? 'crispy-approval-option--selected' : ''}`}
          >
            <input
              type={isMulti ? 'checkbox' : 'radio'}
              name={`q-${qIndex}`}
              checked={otherSelected}
              onChange={() => handleOptionSelect(qIndex, 'Other', isMulti)}
            />
            <div>
              <div className="crispy-approval-option__label">Other</div>
              <div className="crispy-approval-option__desc">Provide a custom answer</div>
            </div>
          </label>
        </div>

        {/* ChatInput for freeform "Other" text */}
        {isOtherVisible(qIndex) && (
          <div className="crispy-approval-other-input">
            <ChatInput
              value={otherTexts[qIndex] ?? ''}
              attachedImages={[]}
              onInput={(v) => setOtherTexts((prev) => ({ ...prev, [qIndex]: v }))}
              onSend={handleSubmit}
              placeholder="Type your answer..."
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="crispy-approval-standard">
      <div className="crispy-approval-header">
        {questions.length === 1 ? questions[0].header : 'Questions'}
      </div>

      {/* Tab bar for multi-question flows */}
      {questions.length > 1 && (
        <div className="crispy-approval-tabs">
          {questions.map((q, i) => (
            <button
              key={i}
              className={`crispy-approval-tab ${activeTab === i ? 'crispy-approval-tab--active' : ''}`}
              onClick={() => setActiveTab(i)}
            >
              {q.header}
              {isAnswered(i) && <span className="crispy-approval-tab__check"> ✓</span>}
            </button>
          ))}
        </div>
      )}

      {/* Question panel */}
      {renderQuestionPanel(activeTab)}

      <div className="crispy-approval-buttons">
        <button
          className="crispy-approval-btn crispy-approval-btn--primary"
          disabled={!allAnswered}
          onClick={handleSubmit}
        >
          Submit
        </button>
      </div>
    </div>
  );
}
