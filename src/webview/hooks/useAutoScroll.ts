/**
 * useAutoScroll — scroll-to-top and scroll-to-bottom via native smooth scroll.
 *
 * Uses the browser's built-in `behavior: 'smooth'` for scroll animations.
 * No custom easing or RAF loops — Chromium handles the curve and timing.
 *
 * @module useAutoScroll
 */

import { useCallback, type RefObject } from "react";

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
  const { scrollRef } = opts;

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

  return {
    isSticky: false,     // permanently show scroll-to-bottom button
    isAtTop: false,      // permanently show scroll-to-top button
    scrollToBottom,
    scrollToTop,
    pinToBottom: scrollToBottom,
  };
}
