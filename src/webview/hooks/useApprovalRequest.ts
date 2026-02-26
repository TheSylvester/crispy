/**
 * useApprovalRequest — listens for awaiting_approval status events
 *
 * Provides the current pending approval and a resolve callback.
 * Single request, no queue. If a second arrives
 * while one is showing, it replaces the current (shouldn't happen in
 * practice since the SDK waits for each approval before proceeding).
 *
 * Listens for:
 * - catchup with pendingApprovals (for late subscribers)
 * - status events with awaiting_approval (for new approval requests)
 * - status events with idle/active (clears approval when resolved)
 *
 * @module useApprovalRequest
 */

import { useState, useEffect, useCallback } from 'react';
import { useTransport } from '../context/TransportContext.js';
import type { ApprovalRequest, ApprovalExtra } from '../components/approval/types.js';

export interface UseApprovalRequestResult {
  /** Current pending approval, or null if none. */
  approvalRequest: ApprovalRequest | null;
  /** Resolve the pending approval with the chosen option ID and optional extra data. */
  resolve: (optionId: string, extra?: ApprovalExtra) => Promise<void>;
}

export function useApprovalRequest(sessionId: string | null): UseApprovalRequestResult {
  const transport = useTransport();
  const [request, setRequest] = useState<ApprovalRequest | null>(null);

  // Clear on session change
  useEffect(() => {
    setRequest(null);
  }, [sessionId]);

  // Listen for approval events
  useEffect(() => {
    if (!sessionId) return;

    const off = transport.onEvent((sid, event) => {
      if (sid !== sessionId) return;

      // Handle catchup with pending approvals (for late subscribers)
      if (event.type === 'catchup') {
        if (event.pendingApprovals.length > 0) {
          // Take the first pending approval (single-request model)
          const approval = event.pendingApprovals[0];
          setRequest({
            toolUseId: approval.toolUseId,
            toolName: approval.toolName,
            input: approval.input,
            reason: approval.reason,
            options: approval.options,
          });
        } else {
          setRequest(null);
        }
        return;
      }

      // Handle status events
      if (event.type === 'event' && event.event.type === 'status') {
        if (event.event.status === 'awaiting_approval') {
          setRequest({
            toolUseId: event.event.toolUseId,
            toolName: event.event.toolName,
            input: event.event.input,
            reason: event.event.reason,
            options: event.event.options,
          });
        } else if (event.event.status === 'idle' || event.event.status === 'active') {
          // Approval resolved or session moved on — clear request
          setRequest(null);
        }
      }
    });

    return off;
  }, [sessionId, transport]);

  const resolve = useCallback(
    async (optionId: string, extra?: ApprovalExtra) => {
      if (!sessionId || !request) return;
      const { toolUseId } = request;
      const savedRequest = request;
      // Clear optimistically to prevent double-click
      setRequest(null);
      try {
        await transport.resolveApproval(sessionId, toolUseId, optionId, extra);
      } catch (err) {
        // Restore the approval UI so the user can retry
        setRequest(savedRequest);
        console.error('[useApprovalRequest] resolveApproval failed:', err);
      }
    },
    [sessionId, request, transport],
  );

  return { approvalRequest: request, resolve };
}
