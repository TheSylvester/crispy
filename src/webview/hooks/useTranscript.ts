/**
 * useTranscript — load + subscribe to a session's transcript
 *
 * When sessionId changes:
 * 1. Subscribe to live events via transport
 * 2. Load history via transport.loadSession()
 * 3. Append live entries as they arrive
 *
 * Known limitation: transport.onEvent() has no removeHandler.
 * We use a `cancelled` flag to ignore stale events after cleanup.
 *
 * @module useTranscript
 */

import { useState, useEffect } from 'react';
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

  useEffect(() => {
    if (!sessionId) {
      setEntries([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    // Listen for live events — uses cancelled flag since onEvent has no unsubscribe
    transport.onEvent((sid, event) => {
      if (cancelled || sid !== sessionId) return;

      if (event.type === 'entry') {
        setEntries((prev) => [...prev, event.entry]);
      } else if (event.type === 'history') {
        // History backfill from subscription — ignore if we already loaded via loadSession
        // loadSession response will overwrite anyway
      }
    });

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        // Subscribe first so we don't miss events between load and subscribe
        await transport.subscribe(sessionId!);
        if (cancelled) return;

        // Load full history — overwrites any early events from subscription backfill
        const history = await transport.loadSession(sessionId!);
        if (cancelled) return;

        setEntries(history);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
      transport.unsubscribe(sessionId).catch(() => {
        // Best-effort unsubscribe
      });
    };
  }, [sessionId, transport]);

  return { entries, isLoading, error };
}
