/**
 * useSessionStatus — track a session's channel state (idle/streaming/etc.)
 *
 * Listens for `state_changed` events on the transport for the selected session.
 * Uses the same cancelled-flag pattern as useTranscript (onEvent has no unsubscribe).
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

    let cancelled = false;

    // Listen for state_changed events — cancelled flag since onEvent has no unsubscribe
    transport.onEvent((sid, event) => {
      if (cancelled || sid !== sessionId) return;
      if (event.type === 'state_changed') {
        setChannelState(event.state);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId, transport]);

  return { channelState };
}
