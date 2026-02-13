/**
 * ExitPlanApproval — structured approval UI for ExitPlanMode tool
 *
 * Presents four options for handling plan completion: clear context
 * with auto-mode, auto-mode only, manual approval, or feedback.
 * Feedback option shows ChatInput for revision notes.
 *
 * @module approval/ExitPlanApproval
 */

import { useState } from 'react';
import type { ExitPlanModeInput, ApprovalExtra } from './types.js';
import { ChatInput } from '../control-panel/ChatInput.js';

type ExitPlanChoice = 'clear_and_auto' | 'auto_only' | 'manual_approve' | 'feedback';

interface ExitPlanApprovalProps {
  input: ExitPlanModeInput;
  bypassEnabled: boolean;
  onResolve: (optionId: string, extra?: ApprovalExtra & { clearContext?: boolean; planContent?: string }) => void;
}

export function ExitPlanApproval({ input, bypassEnabled, onResolve }: ExitPlanApprovalProps): React.JSX.Element {
  const [choice, setChoice] = useState<ExitPlanChoice>('clear_and_auto');
  const [feedbackText, setFeedbackText] = useState('');

  const autoLabel = bypassEnabled ? 'bypass permissions' : 'accept edits';

  const options: Array<{ value: ExitPlanChoice; label: string; description: string }> = [
    {
      value: 'clear_and_auto',
      label: `1. Yes, clear context and ${autoLabel}`,
      description: 'Start a fresh session with the plan as a handoff prompt.',
    },
    {
      value: 'auto_only',
      label: `2. Yes, and ${autoLabel}`,
      description: 'Continue in this session with automatic approvals.',
    },
    {
      value: 'manual_approve',
      label: '3. Manually approve edits',
      description: 'Continue in this session, approving each tool use.',
    },
    {
      value: 'feedback',
      label: '4. Provide feedback',
      description: 'Send feedback to revise the plan before proceeding.',
    },
  ];

  function handleSubmit(): void {
    if (choice === 'feedback') {
      const text = feedbackText.trim() || 'User requested changes';
      onResolve('deny', { message: text });
      return;
    }

    const autoMode = bypassEnabled ? 'bypassPermissions' : 'acceptEdits';
    const suggestion = (choice === 'manual_approve')
      ? { type: 'setMode', mode: 'default', destination: 'session' }
      : { type: 'setMode', mode: autoMode, destination: 'session' };

    const clearContext = choice === 'clear_and_auto';

    onResolve('allow', {
      updatedPermissions: [suggestion],
      clearContext,
      planContent: input.plan,
    });
  }

  return (
    <div className="crispy-approval-standard">
      <div className="crispy-approval-header">Plan Ready for Review</div>

      {/* Requested permissions list */}
      {input.allowedPrompts && input.allowedPrompts.length > 0 && (
        <div className="crispy-approval-permissions">
          <div className="crispy-approval-header__subtitle">Requested permissions:</div>
          <ul className="crispy-approval-permissions-list">
            {input.allowedPrompts.map((p, i) => (
              <li key={i}>
                <span className="crispy-approval-option__label">{p.tool}</span>
                {' — '}
                <span className="crispy-approval-option__desc">{p.prompt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Radio options */}
      <div className="crispy-approval-options">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={`crispy-approval-option ${choice === opt.value ? 'crispy-approval-option--selected' : ''}`}
          >
            <input
              type="radio"
              name="exit-plan-choice"
              checked={choice === opt.value}
              onChange={() => setChoice(opt.value)}
            />
            <div>
              <div className="crispy-approval-option__label">{opt.label}</div>
              <div className="crispy-approval-option__desc">{opt.description}</div>
            </div>
          </label>
        ))}
      </div>

      {/* Feedback ChatInput — its send button doubles as submit */}
      {choice === 'feedback' && (
        <div className="crispy-approval-other-input">
          <ChatInput
            value={feedbackText}
            attachedImages={[]}
            onInput={setFeedbackText}
            onSend={handleSubmit}
            placeholder="Describe the changes you want..."
          />
        </div>
      )}

      {/* Submit button — hidden when feedback ChatInput is visible (it has its own send) */}
      {choice !== 'feedback' && (
        <div className="crispy-approval-buttons">
          <button
            className="crispy-approval-btn crispy-approval-btn--primary"
            onClick={handleSubmit}
          >
            Continue
          </button>
        </div>
      )}
    </div>
  );
}
