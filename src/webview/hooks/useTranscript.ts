/**
 * useTranscript — load + subscribe to a session's transcript
 *
 * When sessionId changes:
 * 1. Subscribe to live events via transport (which includes history in the catchup)
 * 2. Extract history entries from the catchup event
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
  // load cycle (subscribe) because the event stream is already active
  // and entries (including any optimistic ones) should be preserved
  // rather than wiped.
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
    // Skip the clear for:
    // - pending→real transitions (entries are already correct)
    // - null→real transitions (fork-to-new-panel preloads history via setForkHistory)
    if (prevSessionId !== null && !prevSessionId?.startsWith('pending:') && !sessionId.startsWith('pending:')) {
      setEntries([]);
    }

    // Listen for live events
    const off = transport.onEvent((sid, event) => {
      if (unmounted || sid !== sessionId) return;

      if (event.type === 'entry') {
        setEntries((prev) => {
          // Dedup: if the incoming entry is a user message, find and replace
          // its optimistic placeholder (uuid = "optimistic-" + real uuid).
          if (event.entry.type === 'user') {
            const optimisticUuid = 'optimistic-' + event.entry.uuid;
            const idx = prev.findIndex(e => e.uuid === optimisticUuid);
            if (idx !== -1) {
              const next = [...prev];
              next[idx] = event.entry;
              return next;
            }
          }
          return [...prev, event.entry];
        });
      } else if (event.type === 'catchup' && 'entries' in event && event.entries.length > 0) {
        // History is now included in the catchup message.
        // Preserve any optimistic entries already in state.
        setEntries((prev) => {
          // Don't filter optimistic entries by sessionId — during fork,
          // the optimistic entry carries the source session's ID before
          // the fork receipt updates it, causing a mismatch.
          const optimistic = prev.filter(
            (e) => e.uuid?.startsWith('optimistic-')
          );
          if (optimistic.length === 0) return event.entries;
          return [...event.entries, ...optimistic];
        });
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
        // Subscribe — on pending→real transitions this replays catchup from the
        // already-live host subscription, recovering any status/history events
        // that may have raced ahead of the UI's sessionId update.
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

  return { entries, isLoading, error, addOptimisticEntry, setForkHistory };
}
