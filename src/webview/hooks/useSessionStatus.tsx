/**
 * useSessionStatus — shared session channel state (idle/streaming/etc.)
 *
 * A context-based hook so all consumers (App glow, TitleBar dot, StopButton,
 * ThinkingIndicator, ControlPanel) share a single state instance.
 * The provider listens for `state_changed` transport events and also exposes
 * `setOptimistic()` so ControlPanel can set 'streaming' immediately on send.
 *
 * @module useSessionStatus
 */

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { SessionChannelState } from '../../core/session-channel.js';
import { useTransport } from '../context/TransportContext.js';
import { useSession } from '../context/SessionContext.js';

interface SessionStatusValue {
  channelState: SessionChannelState | null;
  /** Optimistically override the channel state (e.g. set 'streaming' on send). */
  setOptimistic: (state: SessionChannelState) => void;
}

const SessionStatusContext = createContext<SessionStatusValue | null>(null);

export function SessionStatusProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const transport = useTransport();
  const { selectedSessionId } = useSession();
  const [channelState, setChannelState] = useState<SessionChannelState | null>(null);

  useEffect(() => {
    if (!selectedSessionId) {
      setChannelState(null);
      return;
    }

    const off = transport.onEvent((sid, event) => {
      if (sid !== selectedSessionId) return;
      if (event.type === 'state_changed') {
        setChannelState(event.state);
      }
    });

    return off;
  }, [selectedSessionId, transport]);

  return (
    <SessionStatusContext.Provider value={{ channelState, setOptimistic: setChannelState }}>
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
