/**
 * useApprovalRequest — approval state from the channel store
 *
 * Thin wrapper around useChannelStore. The store handles all transport
 * event listening and state management for approvals.
 *
 * @module useApprovalRequest
 */

import { useCallback } from 'react';
import { useTransport } from '../context/TransportContext.js';
import { useChannelStore } from './useChannelStore.js';
import type { ApprovalRequest, ApprovalExtra } from '../components/approval/types.js';

export interface UseApprovalRequestResult {
  /** Current pending approval, or null if none. */
  approvalRequest: ApprovalRequest | null;
  /** Resolve the pending approval with the chosen option ID and optional extra data. */
  resolve: (optionId: string, extra?: ApprovalExtra) => Promise<void>;
}

export function useApprovalRequest(sessionId: string | null): UseApprovalRequestResult {
  const transport = useTransport();
  const { approvalRequest, clearApproval, setApproval } = useChannelStore(sessionId);

  const resolve = useCallback(
    async (optionId: string, extra?: ApprovalExtra) => {
      if (!sessionId || !approvalRequest) return;
      const { toolUseId } = approvalRequest;
      const savedRequest = approvalRequest;
      // Clear optimistically to prevent double-click
      clearApproval();
      try {
        await transport.resolveApproval(sessionId, toolUseId, optionId, extra);
      } catch (err) {
        // Restore the approval UI so the user can retry
        setApproval(savedRequest);
        console.error('[useApprovalRequest] resolveApproval failed:', err);
      }
    },
    [sessionId, approvalRequest, clearApproval, setApproval, transport],
  );

  return { approvalRequest, resolve };
}
