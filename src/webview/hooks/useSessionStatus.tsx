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

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
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
    case 'background':
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

  // Track whether state was set optimistically (via setOptimistic) so we
  // can preserve it through session-ID changes caused by sendTurn
  // (new/fork/vendor-switch/pending→real re-keying).
  const optimisticRef = useRef(false);

  const setOptimistic = useCallback((state: SessionChannelState) => {
    optimisticRef.current = true;
    setChannelState(state);
  }, []);

  // Clear error on session switch
  useEffect(() => {
    setLastError(null);
  }, [selectedSessionId]);

  // Track previous selectedSessionId to detect expected transition chains
  // (oldId → pending:xxx → realId) vs unexpected navigations.
  const prevIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prevId = prevIdRef.current;
    prevIdRef.current = selectedSessionId;

    if (!selectedSessionId) {
      optimisticRef.current = false;
      setChannelState(null);
      return;
    }

    // Only preserve optimistic state through the expected transition chain:
    //   oldId → pending:xxx  (sendTurn resolved)
    //   pending:xxx → realId (session_changed fired)
    // Any other transition means the user navigated away — clear optimistic.
    const isPendingToReal = prevId?.startsWith('pending:') && !selectedSessionId.startsWith('pending:');
    const isToPending = selectedSessionId.startsWith('pending:');
    if (!isPendingToReal && !isToPending) {
      optimisticRef.current = false;
    }

    if (!optimisticRef.current) {
      setChannelState(null);
    }

    const off = transport.onEvent((sid, event) => {
      if (sid !== selectedSessionId) return;

      // Handle catchup for initial state sync.
      // Use functional updater so we see the latest state — the closure
      // captures the value from effect setup, which may be stale.
      if (event.type === 'catchup') {
        setChannelState(prev => {
          const mapped = mapCatchupState(event.state);
          // Don't let a catchup downgrade an optimistic 'streaming'.
          // The host re-subscribes on sendTurn (mutable subscriber swap), which
          // fires a catchup with the channel's current state ('idle' or
          // 'background') before the adapter has started. Real status events
          // still override normally.
          if (optimisticRef.current && prev === 'streaming' && (mapped === 'idle' || mapped === 'background')) return prev;
          return mapped;
        });
        return;
      }

      // Handle status events for state transitions — these are
      // authoritative, so clear the optimistic flag.
      if (event.type === 'event' && event.event.type === 'status') {
        optimisticRef.current = false;
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
          case 'background':
            setChannelState('background');
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
    <SessionStatusContext.Provider value={{ channelState, setOptimistic, lastError, clearError }}>
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
