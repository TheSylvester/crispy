/**
 * usePlayback — debug playback state machine
 *
 * Controls how many entries are visible, enabling step-through debugging
 * of transcript rendering. When totalEntries changes (new session loaded),
 * jumps to end and stops playing.
 *
 * @module usePlayback
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const PLAYBACK_INTERVAL_MS = 500;

interface UsePlaybackResult {
  visibleCount: number;
  isPlaying: boolean;
  play: () => void;
  pause: () => void;
  stepForward: () => void;
  stepBack: () => void;
  reset: () => void;
  jumpToEnd: () => void;
}

export function usePlayback(totalEntries: number): UsePlaybackResult {
  const [visibleCount, setVisibleCount] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // When totalEntries changes (new session), jump to end and stop
  useEffect(() => {
    setVisibleCount(totalEntries);
    setIsPlaying(false);
  }, [totalEntries]);

  // Clear interval on unmount or when playing stops
  useEffect(() => {
    if (!isPlaying) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      setVisibleCount((prev) => {
        if (prev >= totalEntries) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, PLAYBACK_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isPlaying, totalEntries]);

  const play = useCallback(() => {
    // If at end, reset to 0 first
    setVisibleCount((prev) => {
      if (prev >= totalEntries) {
        return 0;
      }
      return prev;
    });
    setIsPlaying(true);
  }, [totalEntries]);

  const pause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    setVisibleCount((prev) => Math.min(prev + 1, totalEntries));
  }, [totalEntries]);

  const stepBack = useCallback(() => {
    setIsPlaying(false);
    setVisibleCount((prev) => Math.max(prev - 1, 0));
  }, []);

  const reset = useCallback(() => {
    setIsPlaying(false);
    setVisibleCount(0);
  }, []);

  const jumpToEnd = useCallback(() => {
    setIsPlaying(false);
    setVisibleCount(totalEntries);
  }, [totalEntries]);

  return {
    visibleCount,
    isPlaying,
    play,
    pause,
    stepForward,
    stepBack,
    reset,
    jumpToEnd,
  };
}
