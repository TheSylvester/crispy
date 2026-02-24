/**
 * useChannelState — per-session channel state tracking
 *
 * Standalone per-session hook. Each call independently subscribes to transport
 * events for the given session ID, returning that session's
 * `SessionChannelState`. No context provider needed. Exposes `setOptimistic()`
 * for ControlPanel to set 'streaming' on send.
 *
 * @module useSessionStatus
 */

import { useState, useEffect, useCallback } from 'react';
import type { SessionChannelState } from '../../core/session-channel.js';
import { useTransport } from '../context/TransportContext.js';

// ============================================================================
// Shared helpers
// ============================================================================

/** Map catchup state string to SessionChannelState. */
function mapCatchupState(state: string): SessionChannelState {
  switch (state) {
    case 'idle':
    case 'streaming':
    case 'awaiting_approval':
    case 'unattached':
      return state;
    case 'active':
      return 'streaming';
    default:
      return 'idle';
  }
}

// ============================================================================
// useChannelState — per-session hook (preferred)
// ============================================================================

export interface ChannelStateValue {
  channelState: SessionChannelState | null;
  /** Optimistically override the channel state (e.g. set 'streaming' on send). */
  setOptimistic: (state: SessionChannelState) => void;
}

/**
 * Per-session channel state hook. Subscribes to transport events for the
 * given `sessionId` and returns the current channel state. Each call site
 * gets independent state — no shared context needed.
 */
export function useChannelState(sessionId: string | null): ChannelStateValue {
  const transport = useTransport();
  const [channelState, setChannelState] = useState<SessionChannelState | null>(null);

  // Reset state when session changes
  useEffect(() => {
    if (!sessionId) {
      setChannelState(null);
      return;
    }

    // Subscribe to transport events for this specific session
    const off = transport.onEvent((sid, event) => {
      if (sid !== sessionId) return;

      // Handle catchup for initial state sync
      if (event.type === 'catchup') {
        setChannelState(mapCatchupState(event.state));
        return;
      }

      // Handle status events for state transitions
      if (event.type === 'event' && event.event.type === 'status') {
        switch (event.event.status) {
          case 'active':
            setChannelState('streaming');
            break;
          case 'idle':
            setChannelState('idle');
            break;
          case 'awaiting_approval':
            setChannelState('awaiting_approval');
            break;
        }
      }
    });

    return off;
  }, [sessionId, transport]);

  const setOptimistic = useCallback((state: SessionChannelState) => {
    setChannelState(state);
  }, []);

  return { channelState, setOptimistic };
}
