/**
 * useApprovalRequest — listens for approval_request / approval_resolved events
 *
 * Provides the current pending approval and a resolve callback.
 * Single request, no queue — matches Leto behavior. If a second arrives
 * while one is showing, it replaces the current (shouldn't happen in
 * practice since the SDK waits for each approval before proceeding).
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

      if (event.type === 'approval_request') {
        setRequest({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          reason: event.reason,
          options: event.options,
        });
      } else if (event.type === 'approval_resolved') {
        setRequest((prev) =>
          prev?.toolUseId === event.toolUseId ? null : prev,
        );
      }
    });

    return off;
  }, [sessionId, transport]);

  const resolve = useCallback(
    async (optionId: string, extra?: ApprovalExtra) => {
      if (!sessionId || !request) return;
      const { toolUseId } = request;
      // Clear optimistically to prevent double-click
      setRequest(null);
      await transport.resolveApproval(sessionId, toolUseId, optionId, extra);
    },
    [sessionId, request, transport],
  );

  return { approvalRequest: request, resolve };
}
