/**
 * useTranscript — load + subscribe to a session's transcript
 *
 * When sessionId changes:
 * 1. Subscribe to live events via transport
 * 2. Load history via transport.loadSession()
 * 3. Append live entries as they arrive
 *
 * Optimistic user messages: addOptimisticEntry() injects a synthetic user
 * entry immediately (uuid prefixed with "optimistic-"). When the real echo
 * arrives from the backend, the onEvent handler replaces the optimistic
 * entry to avoid duplicates.
 *
 * @module useTranscript
 */

import { useState, useEffect, useCallback } from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import { useTransport } from '../context/TransportContext.js';

interface UseTranscriptResult {
  entries: TranscriptEntry[];
  isLoading: boolean;
  error: string | null;
  /** Inject a synthetic user entry for immediate rendering before backend echo. */
  addOptimisticEntry: (entry: TranscriptEntry) => void;
}

export function useTranscript(sessionId: string | null): UseTranscriptResult {
  const transport = useTransport();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addOptimisticEntry = useCallback((entry: TranscriptEntry) => {
    setEntries((prev) => [...prev, entry]);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setEntries([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let unmounted = false;

    // Listen for live events
    const off = transport.onEvent((sid, event) => {
      if (unmounted || sid !== sessionId) return;

      if (event.type === 'entry') {
        setEntries((prev) => {
          // Dedup: if the incoming entry is a user message and the last entry is
          // an optimistic placeholder, replace it with the real backend echo.
          const last = prev[prev.length - 1];
          if (
            event.entry.type === 'user' &&
            last?.uuid?.startsWith('optimistic-')
          ) {
            return [...prev.slice(0, -1), event.entry];
          }
          return [...prev, event.entry];
        });
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
        if (unmounted) return;

        // Load full history — overwrites any early events from subscription backfill
        const history = await transport.loadSession(sessionId!);
        if (unmounted) return;

        setEntries(history);
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
      transport.unsubscribe(sessionId).catch(() => {
        // Best-effort unsubscribe
      });
    };
  }, [sessionId, transport]);

  return { entries, isLoading, error, addOptimisticEntry };
}
