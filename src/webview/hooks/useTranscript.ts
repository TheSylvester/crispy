/**
 * useTranscript — load + subscribe to a session's transcript
 *
 * When sessionId changes:
 * 1. Subscribe to live events via transport (which includes history in the catchup)
 * 2. Extract history entries from the catchup event (channel-owned entries)
 * 3. Append live entries as they arrive
 *
 * The channel holds the authoritative entry list. Late subscribers receive
 * a catchup with all accumulated entries. No optimistic entries or dedup
 * logic — the channel-owned entry list eliminates the lost-broadcast problem.
 *
 * @module useTranscript
 */

import { useState, useEffect, useRef } from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import { useTransport } from '../context/TransportContext.js';

interface UseTranscriptResult {
  entries: TranscriptEntry[];
  isLoading: boolean;
  error: string | null;
}

export function useTranscript(sessionId: string | null): UseTranscriptResult {
  const transport = useTransport();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track previous sessionId to detect pending→real transitions.
  // Only clear entries on real→real session switches to avoid visual flash.
  const prevSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;

    if (!sessionId) {
      setEntries([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let unmounted = false;

    // Only clear entries when switching between distinct real sessions.
    // Preserve for: pending→real (same session resolving), real→pending
    // (fork/new send), null→any (fresh mount, fork preview already loaded).
    const isRealToReal = prev !== null
      && !prev.startsWith('pending:')
      && !sessionId.startsWith('pending:');
    if (isRealToReal) setEntries([]);

    const off = transport.onEvent((sid, event) => {
      if (unmounted || sid !== sessionId) return;
      if (event.type === 'entry') {
        setEntries(prev => [...prev, event.entry]);
      } else if (event.type === 'catchup' && 'entries' in event && event.entries.length > 0) {
        setEntries(event.entries);
      } else if (event.type === 'event' && event.event.type === 'notification' && event.event.kind === 'session_rotated') {
        setEntries([]); // Clean slate — old entries flushed by rotation
      }
    });

    async function load() {
      // Skip subscribe for pending sessions — the subscription
      // is already set up by createSession on the host side. Live entries
      // will arrive via the event stream.
      if (sessionId!.startsWith('pending:')) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        await transport.subscribe(sessionId!);
        if (unmounted) return;
      } catch (err) {
        if (unmounted) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!unmounted) {
          setIsLoading(false);
        }
      }
    }

    load();

    return () => {
      unmounted = true;
      off();
      // Skip unsubscribe for pending sessions — they weren't subscribed via transport
      if (!sessionId!.startsWith('pending:')) {
        transport.unsubscribe(sessionId).catch(() => {
          // Best-effort unsubscribe
        });
      }
    };
  }, [sessionId, transport]);

  return { entries, isLoading, error };
}
