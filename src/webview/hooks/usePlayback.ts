/**
 * usePlayback — debug playback state machine
 *
 * Controls how many entries are visible, enabling step-through debugging
 * of transcript rendering. When totalEntries changes (new session loaded),
 * jumps to end and stops playing.
 *
 * Speed presets: 1× (500ms), 2× (250ms), 5× (100ms).
 *
 * @module usePlayback
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export type PlaybackSpeed = 1 | 2 | 5;

const SPEED_INTERVALS: Record<PlaybackSpeed, number> = {
  1: 500,
  2: 250,
  5: 100,
};

export interface UsePlaybackResult {
  visibleCount: number;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  play: () => void;
  pause: () => void;
  stepForward: () => void;
  stepForward10: () => void;
  stepBack: () => void;
  reset: () => void;
  jumpToEnd: () => void;
  setSpeed: (speed: PlaybackSpeed) => void;
}

export function usePlayback(totalEntries: number): UsePlaybackResult {
  const [visibleCount, setVisibleCount] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // When totalEntries changes (new session), jump to end and stop
  useEffect(() => {
    setVisibleCount(totalEntries);
    setIsPlaying(false);
  }, [totalEntries]);

  // Clear interval on unmount or when playing stops or speed changes
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
    }, SPEED_INTERVALS[speed]);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isPlaying, totalEntries, speed]);

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

  const stepForward10 = useCallback(() => {
    setIsPlaying(false);
    setVisibleCount((prev) => Math.min(prev + 10, totalEntries));
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
    speed,
    play,
    pause,
    stepForward,
    stepForward10,
    stepBack,
    reset,
    jumpToEnd,
    setSpeed,
  };
}
