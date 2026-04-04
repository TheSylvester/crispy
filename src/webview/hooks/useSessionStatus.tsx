/**
 * useSessionStatus — shared session channel state (idle/streaming/etc.)
 *
 * Thin wrapper around useChannelStore. All consumers (ConnectionDot,
 * StopButton, ThinkingIndicator, ControlPanel, TabLayout) share the same
 * underlying external store per session ID.
 *
 * @module useSessionStatus
 */

import type { SessionChannelState } from '../../core/session-channel.js';
import { useChannelStore } from './useChannelStore.js';
import { useSession } from '../context/SessionContext.js';

interface SessionStatusValue {
  channelState: SessionChannelState | null;
  /** Optimistically override the channel state (e.g. set 'streaming' on send). */
  setOptimistic: (state: SessionChannelState) => void;
  /** Last error notification from the channel (null if none or cleared). */
  lastError: string | null;
  /** Clear the last error (e.g. on manual dismiss). */
  clearError: () => void;
}

/**
 * Access shared session status. Uses the channel store internally.
 * When sessionId is provided, reads status for that session;
 * otherwise falls back to the globally selected session.
 */
export function useSessionStatus(sessionId?: string | null): SessionStatusValue {
  const { selectedSessionId } = useSession();
  const effectiveId = sessionId ?? selectedSessionId;
  const store = useChannelStore(effectiveId);
  return {
    channelState: store.channelState,
    setOptimistic: store.setOptimistic,
    lastError: store.lastError,
    clearError: store.clearError,
  };
}
