/**
 * useSessionStatus — shared session channel state (idle/streaming/etc.)
 *
 * A context-based hook so all consumers (App glow, TitleBar dot, StopButton,
 * ThinkingIndicator, ControlPanel) share a single state instance.
 * The provider listens for:
 * - `catchup` events for initial state sync
 * - `event` status events for state transitions (active/idle/awaiting_approval)
 * Also exposes `setOptimistic()` so ControlPanel can set 'streaming' immediately on send.
 *
 * @module useSessionStatus
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { SessionChannelState } from '../../core/session-channel.js';
import { useTransport } from '../context/TransportContext.js';
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

const SessionStatusContext = createContext<SessionStatusValue | null>(null);

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

export function SessionStatusProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const transport = useTransport();
  const { selectedSessionId } = useSession();
  const [channelState, setChannelState] = useState<SessionChannelState | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const clearError = useCallback(() => setLastError(null), []);

  // Clear error on session switch
  useEffect(() => {
    setLastError(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      setChannelState(null);
      return;
    }

    const off = transport.onEvent((sid, event) => {
      if (sid !== selectedSessionId) return;

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

      // Surface channel error notifications
      if (event.type === 'event' && event.event.type === 'notification' && event.event.kind === 'error') {
        const errVal = event.event.error;
        setLastError(typeof errVal === 'string' ? errVal : errVal instanceof Error ? errVal.message : 'An unknown error occurred');
      }
    });

    return off;
  }, [selectedSessionId, transport]);

  return (
    <SessionStatusContext.Provider value={{ channelState, setOptimistic: setChannelState, lastError, clearError }}>
      {children}
    </SessionStatusContext.Provider>
  );
}

/**
 * Access shared session status. The sessionId parameter is accepted for
 * backward compatibility but ignored — the provider tracks the selected
 * session automatically.
 */
export function useSessionStatus(_sessionId?: string | null): SessionStatusValue {
  const ctx = useContext(SessionStatusContext);
  if (!ctx) {
    throw new Error('useSessionStatus must be used within a SessionStatusProvider');
  }
  return ctx;
}
