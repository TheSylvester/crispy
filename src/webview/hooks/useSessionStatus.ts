/**
 * useSessionStatus — track a session's channel state (idle/streaming/etc.)
 *
 * Listens for `state_changed` events on the transport for the selected session.
 *
 * Returns null when no session is selected.
 *
 * @module useSessionStatus
 */

import { useState, useEffect } from 'react';
import type { SessionChannelState } from '../../core/session-channel.js';
import { useTransport } from '../context/TransportContext.js';

export function useSessionStatus(sessionId: string | null): {
  channelState: SessionChannelState | null;
} {
  const transport = useTransport();
  const [channelState, setChannelState] = useState<SessionChannelState | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setChannelState(null);
      return;
    }

    const off = transport.onEvent((sid, event) => {
      if (sid !== sessionId) return;
      if (event.type === 'state_changed') {
        setChannelState(event.state);
      }
    });

    return off;
  }, [sessionId, transport]);

  return { channelState };
}
