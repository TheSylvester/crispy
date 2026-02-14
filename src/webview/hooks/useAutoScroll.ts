/**
 * useAutoScroll — smart auto-scroll with FAB visibility and streaming support.
 *
 * Three cooperating mechanisms:
 * 1. RAF-debounced passive scroll listener — tracks position, updates FAB visibility
 * 2. ResizeObserver on content div — auto-scrolls when content grows while near bottom
 * 3. pinToBottom() — forces scroll lock on message send, ResizeObserver sustains it
 *
 * On session load, waits for content to settle (no resize events for SETTLE_MS),
 * then plays a smooth top-to-bottom intro scroll as visual feedback that there's
 * history above. During streaming, instant-scrolls to avoid lag.
 *
 * @module useAutoScroll
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Generous zone for auto-scroll decisions (content growth while near bottom) */
const NEAR_BOTTOM_THRESHOLD = 100;
/** Tight zone for FAB visibility */
const BUTTON_THRESHOLD = 50;
/** Quiet period (ms) after last resize before playing the intro scroll */
const SETTLE_MS = 150;

export interface UseAutoScrollOptions {
  sessionId: string | null;
  /** Ref to the scrollable container (.crispy-transcript) */
  scrollRef: RefObject<HTMLDivElement | null>;
}

export interface UseAutoScrollReturn {
  isSticky: boolean;
  isAtTop: boolean;
  scrollToBottom: () => void;
  scrollToTop: () => void;
  pinToBottom: () => void;
}

export function useAutoScroll(opts: UseAutoScrollOptions): UseAutoScrollReturn {
  const { sessionId, scrollRef } = opts;

  const [isSticky, setIsSticky] = useState(true);
  const [isAtTop, setIsAtTop] = useState(true);

  // Refs for non-rendering state
  const isNearBottomRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const rafIdRef = useRef(0);
  // True during initial session load; cleared after the intro scroll plays.
  const isSessionLoadRef = useRef(true);
  // Settle timer for the intro scroll.
  const settleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ── Session reset ──────────────────────────────────────────────────
  useEffect(() => {
    setIsAtTop(true);
    isNearBottomRef.current = true;
    lastScrollHeightRef.current = 0;
    isSessionLoadRef.current = true;
    clearTimeout(settleTimerRef.current);
  }, [sessionId]);

  // ── 1. Scroll listener (RAF-debounced, passive) ────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        if (!scrollRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

        isNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
        setIsSticky(distanceFromBottom < BUTTON_THRESHOLD);
        setIsAtTop(scrollTop < BUTTON_THRESHOLD);
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafIdRef.current);
    };
  }, [sessionId, scrollRef]);

  // ── 2. ResizeObserver on content div ───────────────────────────────
  // We observe .crispy-transcript-content (the inner div), NOT the scroll
  // container. The scroll container is flex-sized and its own dimensions
  // don't change when children render — only scrollHeight changes, which
  // ResizeObserver doesn't track. The content div's border-box grows as
  // entries mount, so ResizeObserver fires reliably.
  //
  // During session load, instant-scroll keeps us at the bottom while
  // content renders. A settle timer (debounced by each resize) fires once
  // content stops growing — then we jump to top and smooth-scroll down
  // as the intro animation. This avoids the smooth scroll getting
  // cancelled by subsequent instant scrolls during the render cascade.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const contentEl = scrollEl.querySelector('.crispy-transcript-content');
    if (!contentEl) return;

    const observer = new ResizeObserver(() => {
      if (!scrollRef.current) return;
      const el = scrollRef.current;
      const newScrollHeight = el.scrollHeight;
      const grew = newScrollHeight > lastScrollHeightRef.current;
      lastScrollHeightRef.current = newScrollHeight;

      if (grew && isNearBottomRef.current) {
        // Always instant-scroll to keep up with content growth.
        el.scrollTop = newScrollHeight;

        if (isSessionLoadRef.current) {
          // Content is still settling — reset the debounce timer.
          // When it finally fires, we play the intro scroll.
          clearTimeout(settleTimerRef.current);
          settleTimerRef.current = setTimeout(() => {
            if (!scrollRef.current || !isSessionLoadRef.current) return;
            isSessionLoadRef.current = false;
            const settled = scrollRef.current;
            settled.scrollTop = 0;
            settled.scrollTo({ top: settled.scrollHeight, behavior: "smooth" });
          }, SETTLE_MS);
        }
      }
    });

    observer.observe(contentEl);
    return () => {
      observer.disconnect();
      clearTimeout(settleTimerRef.current);
    };
  }, [sessionId, scrollRef]);

  // ── User-initiated smooth scrolls (FAB clicks) ────────────────────
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [scrollRef]);

  const scrollToTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: "smooth" });
  }, [scrollRef]);

  // ── 3. pinToBottom — called on message send ────────────────────────
  // Cancels any pending intro scroll — sending a message means the user
  // is already engaged, no need for theatrics.
  const pinToBottom = useCallback(() => {
    isSessionLoadRef.current = false;
    clearTimeout(settleTimerRef.current);
    isNearBottomRef.current = true;
    setIsSticky(true);
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [scrollRef]);

  return {
    isSticky,
    isAtTop,
    scrollToBottom,
    scrollToTop,
    pinToBottom,
  };
}
