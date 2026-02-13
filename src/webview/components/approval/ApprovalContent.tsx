/**
 * Approval Content — routes to the correct approval renderer by toolName
 *
 * This is what gets passed as `children` to ControlPanel. It renders
 * inside the `.crispy-cp` shell, replacing AttachmentsRow + ChatInput.
 * Not a positioned container — the shell handles positioning.
 *
 * Routes by tool name:
 * - AskUserQuestion → AskUserApproval (structured question/answer UI)
 * - ExitPlanMode → ExitPlanApproval (plan review with mode selection)
 * - EnterPlanMode → auto-approved (no UI)
 * - Everything else → StandardApproval (YAML preview + buttons)
 *
 * @module approval/ApprovalContent
 */

import { useEffect } from 'react';
import type { ApprovalRequest, ApprovalExtra, AskUserQuestionInput, ExitPlanModeInput } from './types.js';
import { StandardApproval } from './StandardApproval.js';
import { AskUserApproval } from './AskUserApproval.js';
import { ExitPlanApproval } from './ExitPlanApproval.js';

interface ApprovalContentProps {
  request: ApprovalRequest;
  onResolve: (optionId: string, extra?: ApprovalExtra) => void;
  bypassEnabled: boolean;
}

export function ApprovalContent({
  request,
  onResolve,
  bypassEnabled,
}: ApprovalContentProps): React.JSX.Element | null {
  // EnterPlanMode: auto-approve immediately without showing UI
  useEffect(() => {
    if (request.toolName === 'EnterPlanMode') {
      onResolve('allow');
    }
  }, [request.toolName, onResolve]);

  if (request.toolName === 'EnterPlanMode') {
    return null;
  }

  if (request.toolName === 'AskUserQuestion') {
    return <AskUserApproval input={request.input as AskUserQuestionInput} onResolve={onResolve} />;
  }

  if (request.toolName === 'ExitPlanMode') {
    return (
      <ExitPlanApproval
        input={request.input as ExitPlanModeInput}
        bypassEnabled={bypassEnabled}
        onResolve={onResolve}
      />
    );
  }

  return (
    <StandardApproval
      toolName={request.toolName}
      input={request.input}
      reason={request.reason}
      options={request.options}
      onResolve={onResolve}
    />
  );
}
