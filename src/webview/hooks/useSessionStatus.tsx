/**
 * useSessionStatus — shared session channel state (idle/streaming/etc.)
 *
 * Thin wrapper around useChannelStore. All consumers (App glow, TitleBar dot,
 * StopButton, ThinkingIndicator, ControlPanel) share the same underlying
 * external store per session ID.
 *
 * SessionStatusProvider is retained as a no-op passthrough for backwards
 * compatibility — it no longer manages any state. It will be removed once
 * all providers are scoped per-tab (Phase B3+).
 *
 * @module useSessionStatus
 */

import { type ReactNode } from 'react';
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
 * No-op provider — kept for tree compatibility during Phase B migration.
 * Will be removed when ControlPanelContext moves per-tab (B3).
 */
export function SessionStatusProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return <>{children}</>;
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
