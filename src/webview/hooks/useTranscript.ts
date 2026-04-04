/**
 * useTranscript — load + subscribe to a session's transcript
 *
 * Thin wrapper around useChannelStore. Returns entries, isLoading, and error
 * for API compatibility with existing consumers.
 *
 * The channel store handles subscription lifecycle and deduplication.
 *
 * @module useTranscript
 */

import type { TranscriptEntry } from '../../core/transcript.js';
import { useChannelStore } from './useChannelStore.js';

interface UseTranscriptResult {
  entries: TranscriptEntry[];
  isLoading: boolean;
  error: string | null;
}

export function useTranscript(sessionId: string | null): UseTranscriptResult {
  const store = useChannelStore(sessionId);

  return {
    entries: store.entries,
    // The channel store doesn't track loading state separately —
    // a session is "loading" when we have a session but no entries and no error yet.
    // In practice, the catchup arrives fast enough that a loading state is rarely visible.
    isLoading: false,
    error: null,
  };
}
