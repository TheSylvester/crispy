/**
 * Approval Content — routes to the correct approval renderer by toolName
 *
 * This is what gets passed as `children` to ControlPanel. It renders
 * inside the `.crispy-cp` shell, replacing AttachmentsRow + ChatInput.
 * Not a positioned container — the shell handles positioning.
 *
 * Phase 1: routes to StandardApproval for all tools.
 * Phase 2/3: will add AskUserApproval, ExitPlanApproval routes.
 *
 * @module approval/ApprovalContent
 */

import { useEffect } from 'react';
import type { ApprovalRequest } from './types.js';
import { StandardApproval } from './StandardApproval.js';

interface ApprovalContentProps {
  request: ApprovalRequest;
  onResolve: (optionId: string) => void;
}

export function ApprovalContent({
  request,
  onResolve,
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

  // Phase 2: AskUserQuestion → <AskUserApproval />
  // Phase 3: ExitPlanMode → <ExitPlanApproval />

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
