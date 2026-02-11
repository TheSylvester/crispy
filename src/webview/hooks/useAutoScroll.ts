/**
 * Auto-scroll hook for chat-style "sticky bottom" behavior.
 *
 * Two distinct phases:
 *
 * 1. INITIAL — content is hidden (opacity: 0 via CSS). Once the entry
 *    count stabilizes (no changes for SETTLE_MS), we reveal content with
 *    a CSS fade-in and play a one-shot JS tween from top → bottom.
 *
 * 2. LIVE — ResizeObserver on the content wrapper instantly pins scrollTop
 *    to the bottom when content grows while sticky. No animation, no
 *    debounce — multiple fires are harmless (each just re-pins).
 *
 * Sticky detection uses a scroll-event listener with a threshold check
 * rather than IntersectionObserver — simpler and more predictable.
 *
 * Inspired by Leto's webview-next pattern: full render → scrollToBottom()
 * for initial load, isNearBottom() check before auto-scrolling on append.
 *
 * @module useAutoScroll
 */

import { useRef, useState, useEffect, useCallback } from "react";

// --- Configuration ---

/** Wait for entry count to stop changing before considering load settled. */
const SETTLE_MS = 200;

/** Duration of the initial-load scroll tween. */
const INITIAL_TWEEN_MS = 1000;

/** If within this many px of bottom, consider user "sticky". */
const STICKY_THRESHOLD_PX = 80;

// --- Types ---

export interface UseAutoScrollOptions {
  /** Scroll container (e.g. .crispy-transcript) */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Inner content wrapper — observed for size changes during streaming */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Number of rendered entries (drives settle detection) */
  entryCount: number;
  /** Current session ID — triggers reset on session switch */
  sessionId: string | null;
}

export interface UseAutoScrollReturn {
  /** Whether auto-scroll is engaged (user is at bottom) */
  isSticky: boolean;
  /** Smooth-scroll to bottom (for the FAB button) */
  scrollToBottom: () => void;
  /** False while initial content is loading; true once ready to show */
  contentReady: boolean;
}

// --- Easing ---

/** Slow start → fast middle → slow stop. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// --- Hook ---

export function useAutoScroll({
  containerRef,
  contentRef,
  entryCount,
  sessionId,
}: UseAutoScrollOptions): UseAutoScrollReturn {
  const enabled = !!sessionId;
  const [isSticky, setIsSticky] = useState(true);
  const [contentReady, setContentReady] = useState(false);

  const isStickyRef = useRef(true);
  const phaseRef = useRef<"initial" | "live">("initial");
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tweenRafRef = useRef<number>(0);

  // --- Reset on session switch ---
  useEffect(() => {
    isStickyRef.current = true;
    setIsSticky(true);
    setContentReady(false);
    phaseRef.current = "initial";

    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    if (tweenRafRef.current) {
      cancelAnimationFrame(tweenRafRef.current);
      tweenRafRef.current = 0;
    }

    // Start at top so the initial tween has somewhere to go
    const container = containerRef.current;
    if (container) container.scrollTop = 0;
  }, [sessionId, containerRef]);

  // --- Sticky detection via scroll event ---
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    function onScroll() {
      const el = container!;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD_PX;

      if (atBottom !== isStickyRef.current) {
        isStickyRef.current = atBottom;
        setIsSticky(atBottom);
      }
    }

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [enabled, containerRef]);

  // --- Initial load: settle detection + one-shot tween ---
  useEffect(() => {
    if (!enabled || phaseRef.current !== "initial") return;

    // Restart settle timer on every entryCount change
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);

    // Don't start timer until we actually have entries
    if (entryCount === 0) return;

    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      phaseRef.current = "live";

      const container = containerRef.current;
      if (!container) {
        setContentReady(true);
        return;
      }

      const maxScroll = container.scrollHeight - container.clientHeight;

      if (maxScroll <= 0) {
        // Content fits without scrolling — just reveal
        setContentReady(true);
        return;
      }

      // Reveal (CSS fade-in) and tween scroll simultaneously
      setContentReady(true);

      const startScroll = container.scrollTop; // should be 0
      const startTime = performance.now();

      function step(now: number) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / INITIAL_TWEEN_MS, 1);
        const eased = easeInOutCubic(progress);

        container!.scrollTop = startScroll + (maxScroll - startScroll) * eased;

        if (progress < 1) {
          tweenRafRef.current = requestAnimationFrame(step);
        } else {
          tweenRafRef.current = 0;
          isStickyRef.current = true;
          setIsSticky(true);
        }
      }

      tweenRafRef.current = requestAnimationFrame(step);
    }, SETTLE_MS);

    return () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [enabled, entryCount, containerRef]);

  // --- Streaming: ResizeObserver pins to bottom (instant, no tween) ---
  useEffect(() => {
    if (!enabled) return;
    const content = contentRef.current;
    const container = containerRef.current;
    if (!content || !container) return;

    const observer = new ResizeObserver(() => {
      // Only auto-scroll during live phase when user is at bottom
      if (phaseRef.current !== "live" || !isStickyRef.current) return;
      container.scrollTop = container.scrollHeight;
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [enabled, containerRef, contentRef]);

  // --- FAB button: native smooth scroll ---
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (tweenRafRef.current) {
      cancelAnimationFrame(tweenRafRef.current);
      tweenRafRef.current = 0;
    }

    isStickyRef.current = true;
    setIsSticky(true);
    container.scrollTo({
      top: container.scrollHeight - container.clientHeight,
      behavior: "smooth",
    });
  }, [containerRef]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      if (tweenRafRef.current) cancelAnimationFrame(tweenRafRef.current);
    };
  }, []);

  return { isSticky, scrollToBottom, contentReady };
}
