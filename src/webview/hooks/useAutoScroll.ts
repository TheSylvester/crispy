/**
 * useAutoScroll — smart auto-scroll with FAB visibility and streaming support.
 *
 * Three cooperating mechanisms:
 * 1. RAF-debounced passive scroll listener — tracks position, updates FAB visibility
 * 2. ResizeObserver on content div — auto-scrolls when content grows while near bottom
 * 3. pinToBottom() — forces scroll lock on message send, ResizeObserver sustains it
 *
 * Uses the browser's built-in `behavior: 'smooth'` for user-initiated scrolls (FAB clicks).
 * Content-growth auto-scroll uses instant scrolling to avoid lag during streaming.
 *
 * @module useAutoScroll
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Generous zone for auto-scroll decisions (content growth while near bottom) */
const NEAR_BOTTOM_THRESHOLD = 100;
/** Tight zone for FAB visibility */
const BUTTON_THRESHOLD = 50;

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

  // ── Session reset ──────────────────────────────────────────────────
  // Reset refs so the ResizeObserver treats the next content render as
  // "grew from 0" and auto-scrolls. We do NOT force isSticky here —
  // the scroll listener will set it based on actual position after the
  // auto-scroll lands.
  useEffect(() => {
    setIsAtTop(true);
    isNearBottomRef.current = true;
    lastScrollHeightRef.current = 0;
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
  // We read scrollHeight from the scroll container (scrollRef) for the
  // auto-scroll math, since that's where overflow lives.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const contentEl = scrollEl.querySelector('.crispy-transcript-content');
    if (!contentEl) return;

    const observer = new ResizeObserver(() => {
      if (!scrollRef.current) return;
      const newScrollHeight = scrollRef.current.scrollHeight;
      const grew = newScrollHeight > lastScrollHeightRef.current;
      lastScrollHeightRef.current = newScrollHeight;

      if (grew && isNearBottomRef.current) {
        // Instant scroll — smooth causes perpetual lag during streaming
        scrollRef.current.scrollTop = newScrollHeight;
      }
    });

    observer.observe(contentEl);
    return () => observer.disconnect();
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
  const pinToBottom = useCallback(() => {
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
