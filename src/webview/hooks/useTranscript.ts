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

import { useState, useEffect, useCallback, useRef } from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import { useTransport } from '../context/TransportContext.js';

interface UseTranscriptResult {
  entries: TranscriptEntry[];
  isLoading: boolean;
  error: string | null;
  /** Inject a synthetic user entry for immediate rendering before backend echo. */
  addOptimisticEntry: (entry: TranscriptEntry) => void;
  /** Bulk-set entries for fork history preload. Replaces all entries including optimistic. */
  setForkHistory: (entries: TranscriptEntry[]) => void;
}

export function useTranscript(sessionId: string | null): UseTranscriptResult {
  const transport = useTransport();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track previous sessionId to detect pending→real transitions.
  // When a pending session resolves to its real ID, we skip the full
  // load cycle (subscribe + loadSession) because the event stream is
  // already active and entries (including any optimistic ones) should
  // be preserved rather than wiped.
  const prevSessionIdRef = useRef<string | null>(null);

  const addOptimisticEntry = useCallback((entry: TranscriptEntry) => {
    setEntries((prev) => [...prev, entry]);
  }, []);

  const setForkHistory = useCallback((forkEntries: TranscriptEntry[]) => {
    setEntries(forkEntries);
  }, []);

  useEffect(() => {
    const prevSessionId = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;

    if (!sessionId) {
      setEntries([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    let unmounted = false;

    // Clear stale entries immediately so optimistic messages from a
    // previous session never bleed into the newly selected one.
    // Skip the clear for pending→real transitions (entries are already correct).
    if (!prevSessionId?.startsWith('pending:') && !sessionId.startsWith('pending:')) {
      setEntries([]);
    }

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
        // History backfill from subscription — handled by setForkHistory for forks,
        // overwritten by loadSession response for normal sessions.
      }
    });

    async function load() {
      // Skip subscribe/loadSession for pending sessions — the subscription
      // is already set up by createSession on the host side. Live entries
      // will arrive via the event stream.
      if (sessionId!.startsWith('pending:')) {
        setIsLoading(false);
        return;
      }

      // Pending→real transition: the previous session was a pending placeholder
      // that has now resolved to its real ID. The event stream is already active
      // (the host re-keys the channel), so entries and optimistic messages are
      // already in state. Skip the destructive load cycle to preserve them.
      if (prevSessionId?.startsWith('pending:')) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        // Subscribe first so we don't miss events between load and subscribe
        await transport.subscribe(sessionId!);
        if (unmounted) return;

        // Load full history — overwrites any early events from subscription backfill.
        // Preserve optimistic entries that haven't been echoed yet.
        const history = await transport.loadSession(sessionId!);
        if (unmounted) return;

        setEntries((prev) => {
          // Only preserve optimistic entries that belong to *this* session.
          // The early clear (above) already flushed cross-session leftovers,
          // but guard here too: only keep entries added after the clear.
          const optimistic = prev.filter(
            (e) => e.uuid?.startsWith('optimistic-') && e.sessionId === sessionId
          );
          if (optimistic.length === 0) return history;
          return [...history, ...optimistic];
        });
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

  return { entries, isLoading, error, addOptimisticEntry, setForkHistory };
}
