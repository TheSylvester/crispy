/**
 * useAutoScroll v2 — intent-driven scroll for multi-tab layouts.
 *
 * Single source of truth: `stickToBottom` boolean.
 * Visibility: driven by FlexLayout's TabNode.isVisible(), not heuristics.
 * Save/restore: explicit, because display:none zeroes scrollTop (CSSOM View spec).
 * No timers, no guards, no intro animation.
 *
 * @module useAutoScroll
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Distance from bottom the user must scroll before we unpark. */
const UNPARK_THRESHOLD = 100;
/** User must scroll within this distance to re-park by position. */
const REPARK_THRESHOLD = 10;
/** Distance from top before we show the scroll-to-top button. */
const AT_TOP_THRESHOLD = 50;

export interface UseAutoScrollOptions {
  sessionId: string | null;
  /** Ref to the scrollable container (.crispy-transcript) */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** FlexLayout ground-truth DOM visibility (from TabContainerContext) */
  isDomVisible: boolean;
  /** Register a callback that fires synchronously before display:none (from TabContainerContext) */
  registerOnBeforeHide: (cb: (() => void) | null) => void;
  /** Extra signal to re-attach when the scroll container mounts (e.g. fork history preload). */
  remount?: boolean;
}

export interface UseAutoScrollReturn {
  /** True when the user intends to stay at the bottom of the transcript. */
  stickToBottom: boolean;
  /** True when scrolled to the very top (hides scroll-to-top button). */
  isAtTop: boolean;
  scrollToBottom: () => void;
  scrollToTop: () => void;
  pinToBottom: () => void;
}

type ScrollSource = "programmatic" | "user" | null;

export function useAutoScroll(opts: UseAutoScrollOptions): UseAutoScrollReturn {
  const { sessionId, scrollRef, isDomVisible, registerOnBeforeHide, remount } = opts;

  const [stickToBottom, setStickToBottom] = useState(true);
  const [isAtTop, setIsAtTop] = useState(true);

  const stickRef = useRef(true);
  const savedScrollTop = useRef<number | null>(null);
  const scrollSource = useRef<ScrollSource>(null);
  const prevVisibleRef = useRef(isDomVisible);

  const setStick = useCallback((next: boolean) => {
    stickRef.current = next;
    setStickToBottom(prev => (prev === next ? prev : next));
  }, []);

  // ── Effect 1: Session/fork reset → always stick ──────────────────
  useEffect(() => {
    setStick(true);
    setIsAtTop(true);
    savedScrollTop.current = null;
    scrollSource.current = null;
  }, [sessionId, remount, setStick]);

  // ── Save scroll position before FlexLayout hides the tab ─────────
  useEffect(() => {
    registerOnBeforeHide(() => {
      if (scrollRef.current) savedScrollTop.current = scrollRef.current.scrollTop;
    });
    return () => registerOnBeforeHide(null);
  }, [scrollRef, registerOnBeforeHide]);

  // ── Effect 2: Scroll listener — only when DOM visible ────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isDomVisible) return;

    const evaluate = (allowUnpark: boolean) => {
      const cur = scrollRef.current;
      if (!cur || cur.clientHeight === 0) return;
      const dist = cur.scrollHeight - cur.scrollTop - cur.clientHeight;

      setIsAtTop(prev => {
        const next = cur.scrollTop < AT_TOP_THRESHOLD;
        return prev === next ? prev : next;
      });

      if (dist <= REPARK_THRESHOLD) {
        setStick(true);
        savedScrollTop.current = null;
        return;
      }

      if (allowUnpark && dist >= UNPARK_THRESHOLD) {
        setStick(false);
      }

      if (!stickRef.current) {
        savedScrollTop.current = cur.scrollTop;
      }
    };

    const onScroll = () => {
      evaluate(scrollSource.current !== "programmatic");
    };

    const markUserScroll = () => {
      scrollSource.current = "user";
    };

    // Keyboard navigation keys (PageUp/Down, arrows, Home/End, Space)
    // don't fire wheel/touch/pointer events. Without this, keyboard scrolls
    // during active streaming can't unpark because ResizeObserver keeps
    // re-arming scrollSource to "programmatic" between scroll events.
    const onKeyDown = (e: KeyboardEvent) => {
      const navKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
      if (navKeys.has(e.key)) scrollSource.current = "user";
    };

    const onScrollEnd = () => {
      scrollSource.current = null;
      evaluate(true); // final honest position
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", markUserScroll, { passive: true });
    el.addEventListener("touchstart", markUserScroll, { passive: true });
    el.addEventListener("pointerdown", markUserScroll, { passive: true });
    el.addEventListener("scrollend", onScrollEnd);
    // keydown on window — keyboard events fire on the focused element (chat input),
    // not on the scroll container. The browser still scrolls the nearest scrollable
    // ancestor, so scroll events fire on `el`, but keydown doesn't.
    window.addEventListener("keydown", onKeyDown);

    // Sync on attach — but skip during visibility restore (false→true transition).
    // Effect 3 handles restore via rAF; evaluating here would clobber
    // savedScrollTop with the post-display:none zero value.
    if (el.clientHeight > 0 && prevVisibleRef.current) evaluate(false);

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", markUserScroll);
      el.removeEventListener("touchstart", markUserScroll);
      el.removeEventListener("pointerdown", markUserScroll);
      el.removeEventListener("scrollend", onScrollEnd);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isDomVisible, remount, scrollRef, sessionId, setStick]);

  // ── Effect 3: ResizeObserver + visibility restore ────────────────
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    // Visibility restore: false→true transition
    if (isDomVisible && !prevVisibleRef.current) {
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el || el.clientHeight === 0) return;
        if (stickRef.current) {
          scrollSource.current = "programmatic";
          el.scrollTop = el.scrollHeight;
          savedScrollTop.current = null;
        } else if (savedScrollTop.current != null) {
          el.scrollTop = Math.max(0, Math.min(savedScrollTop.current, el.scrollHeight - el.clientHeight));
        }
      });
    }
    prevVisibleRef.current = isDomVisible;

    if (!isDomVisible) return;

    const contentEl = scrollEl.querySelector('.crispy-transcript-content');
    if (!(contentEl instanceof HTMLElement)) return;

    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (!el || el.clientHeight === 0) return;

      if (stickRef.current) {
        scrollSource.current = "programmatic";
        el.scrollTop = el.scrollHeight;
        savedScrollTop.current = null;
      }
    });

    observer.observe(scrollEl);
    observer.observe(contentEl);

    // Initial pin if visible and stuck
    const frameId = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && el.clientHeight > 0 && stickRef.current) {
        scrollSource.current = "programmatic";
        el.scrollTop = el.scrollHeight;
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [isDomVisible, remount, scrollRef, sessionId]);

  // ── User-initiated scroll commands ───────────────────────────────
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setStick(true);
    savedScrollTop.current = null;
    scrollSource.current = "programmatic";
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [scrollRef, setStick]);

  const scrollToTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setStick(false);
    savedScrollTop.current = 0;
    scrollSource.current = "programmatic";
    el.scrollTo({ top: 0, behavior: "smooth" });
  }, [scrollRef, setStick]);

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setStick(true);
    savedScrollTop.current = null;
    scrollSource.current = "programmatic";
    el.scrollTop = el.scrollHeight;
  }, [scrollRef, setStick]);

  return { stickToBottom, isAtTop, scrollToBottom, scrollToTop, pinToBottom };
}
