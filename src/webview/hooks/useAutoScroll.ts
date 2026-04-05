/**
 * useAutoScroll — intent-driven scroll management for multi-tab layouts.
 *
 * Single source of truth: `parked` boolean = "user wants to stay at bottom."
 *
 * FlexLayout hides inactive tabs with `display: none`, so hidden tabs cannot be
 * measured reliably. This hook saves the transcript scroll position on
 * deactivation, restores it on activation when the user has scrolled away, and
 * otherwise keeps parked tabs pinned to the bottom.
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
/** Timeout fallback for smooth-scroll completion. */
const PROGRAMMATIC_SCROLL_GUARD_MS = 450;

export interface UseAutoScrollOptions {
  sessionId: string | null;
  /** Ref to the scrollable container (.crispy-transcript) */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Extra signal to re-attach when the scroll container mounts (e.g. fork history preload). */
  remount?: boolean;
  /** Whether this tab is currently active — listeners/observers are disconnected when false. */
  isActiveTab?: boolean;
}

export interface UseAutoScrollReturn {
  /** True when the user intends to stay at the bottom of the transcript. */
  parked: boolean;
  /** True when scrolled to the very top (hides scroll-to-top button). */
  isAtTop: boolean;
  scrollToBottom: () => void;
  scrollToTop: () => void;
  pinToBottom: () => void;
}

function clampScrollTop(el: HTMLDivElement, top: number): number {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  return Math.max(0, Math.min(top, max));
}

export function useAutoScroll(opts: UseAutoScrollOptions): UseAutoScrollReturn {
  const { sessionId, scrollRef, remount } = opts;
  // isActiveTab from props is ignored — we derive visibility from the DOM
  // because FlexLayout split views have multiple visible tabs simultaneously.

  const [parked, setParked] = useState(true);
  const [isAtTop, setIsAtTop] = useState(true);

  const parkedRef = useRef(true);
  const savedScrollTopRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Track DOM visibility (display:none → clientHeight===0).
  const wasVisibleRef = useRef(false);
  // One-shot intro animation per session: small "peek" scroll to hint at history above.
  const introPlayedForRef = useRef<string | null>(null);
  const introSettleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const setParkedState = useCallback((next: boolean) => {
    parkedRef.current = next;
    setParked(prev => (prev === next ? prev : next));
  }, []);

  const clearProgrammaticGuard = useCallback(() => {
    programmaticScrollRef.current = false;
    clearTimeout(programmaticTimerRef.current);
  }, []);

  const beginProgrammaticGuard = useCallback(() => {
    clearTimeout(programmaticTimerRef.current);
    programmaticScrollRef.current = true;
    programmaticTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, PROGRAMMATIC_SCROLL_GUARD_MS);
  }, []);

  const syncFromElement = useCallback((el: HTMLDivElement, allowUnpark: boolean) => {
    const { scrollTop, scrollHeight, clientHeight } = el;
    const distFromBottom = scrollHeight - scrollTop - clientHeight;

    setIsAtTop(prev => {
      const next = scrollTop < AT_TOP_THRESHOLD;
      return prev === next ? prev : next;
    });

    if (distFromBottom <= REPARK_THRESHOLD) {
      setParkedState(true);
      savedScrollTopRef.current = null;
      return;
    }

    if (allowUnpark && distFromBottom >= UNPARK_THRESHOLD) {
      setParkedState(false);
    }

    if (!parkedRef.current) {
      savedScrollTopRef.current = scrollTop;
    }
  }, [setParkedState]);

  // ── Session / fork reset → always park ────────────────────────────
  useEffect(() => {
    clearProgrammaticGuard();
    clearTimeout(introSettleTimerRef.current);
    setParkedState(true);
    setIsAtTop(true);
    savedScrollTopRef.current = null;
    introPlayedForRef.current = null;
  }, [clearProgrammaticGuard, remount, sessionId, setParkedState]);

  // ── Scroll listener — always attached, guards on visibility ────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      const currentEl = scrollRef.current;
      if (!currentEl || currentEl.clientHeight === 0) return;
      syncFromElement(currentEl, !programmaticScrollRef.current);
    };

    const cancelProgrammaticScroll = () => {
      clearProgrammaticGuard();
    };

    const onScrollEnd = () => {
      clearProgrammaticGuard();
      if (scrollRef.current && scrollRef.current.clientHeight > 0) {
        syncFromElement(scrollRef.current, false);
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", cancelProgrammaticScroll, { passive: true });
    el.addEventListener("touchstart", cancelProgrammaticScroll, { passive: true });
    el.addEventListener("pointerdown", cancelProgrammaticScroll, { passive: true });
    el.addEventListener("scrollend", onScrollEnd as EventListener);

    // Sync on attach if visible.
    if (el.clientHeight > 0) onScroll();

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", cancelProgrammaticScroll);
      el.removeEventListener("touchstart", cancelProgrammaticScroll);
      el.removeEventListener("pointerdown", cancelProgrammaticScroll);
      el.removeEventListener("scrollend", onScrollEnd as EventListener);
    };
  }, [clearProgrammaticGuard, remount, scrollRef, sessionId, syncFromElement]);

  // ── ResizeObserver: content growth, viewport resize, AND visibility
  // When the tab transitions from display:none to visible, the scroll
  // container goes from 0×0 to real dimensions — the observer fires.
  // We detect this transition and restore/pin scroll position.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const contentEl = scrollEl.querySelector('.crispy-transcript-content');
    if (!(contentEl instanceof HTMLElement)) return;

    // Seed initial visibility.
    wasVisibleRef.current = scrollEl.clientHeight > 0;

    const handleResize = () => {
      const el = scrollRef.current;
      if (!el) return;

      const isVisible = el.clientHeight > 0;
      const wasVisible = wasVisibleRef.current;
      wasVisibleRef.current = isVisible;

      if (!isVisible) {
        // Going hidden: save scroll position.
        if (wasVisible && !parkedRef.current) {
          savedScrollTopRef.current = el.scrollTop;
        }
        return;
      }

      if (!wasVisible && isVisible) {
        // Becoming visible: restore or pin.
        requestAnimationFrame(() => {
          if (!scrollRef.current || scrollRef.current.clientHeight === 0) return;
          const target = scrollRef.current;
          if (parkedRef.current) {
            target.scrollTop = target.scrollHeight;
            savedScrollTopRef.current = null;
          } else if (savedScrollTopRef.current != null) {
            target.scrollTop = clampScrollTop(target, savedScrollTopRef.current);
          }
          syncFromElement(target, false);
        });
        return;
      }

      // Normal resize while visible: apply parked policy.
      if (parkedRef.current) {
        el.scrollTop = el.scrollHeight;
        savedScrollTopRef.current = null;

        // Intro scroll: after content stops growing for 250ms, start
        // one viewport above the bottom and smooth-scroll down. Gives
        // spatial context that there's history above. One-shot per session.
        if (sessionId && introPlayedForRef.current !== sessionId) {
          clearTimeout(introSettleTimerRef.current);
          introSettleTimerRef.current = setTimeout(() => {
            if (!scrollRef.current || introPlayedForRef.current === sessionId) return;
            introPlayedForRef.current = sessionId;
            const target = scrollRef.current;
            if (!parkedRef.current || target.clientHeight === 0) return;
            const { scrollHeight, clientHeight } = target;
            if (scrollHeight <= clientHeight * 1.5) return; // not enough content to bother

            // Start one viewport above the bottom, smooth-scroll to bottom.
            const startAt = Math.max(0, scrollHeight - clientHeight * 2);
            target.scrollTop = startAt;
            beginProgrammaticGuard();
            target.scrollTo({ top: scrollHeight, behavior: "smooth" });
          }, 250);
        }
      } else {
        savedScrollTopRef.current = el.scrollTop;
      }

      syncFromElement(el, false);
    };

    const observer = new ResizeObserver(() => {
      handleResize();
    });

    observer.observe(scrollEl);
    observer.observe(contentEl);

    // Initial pin if visible and parked.
    const frameId = requestAnimationFrame(() => {
      if (scrollRef.current && scrollRef.current.clientHeight > 0) {
        handleResize();
      }
    });

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [remount, scrollRef, sessionId, syncFromElement]);

  // ── User-initiated scroll commands ────────────────────────────────
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    setParkedState(true);
    savedScrollTopRef.current = null;
    beginProgrammaticGuard();
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [beginProgrammaticGuard, scrollRef, setParkedState]);

  const scrollToTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    setParkedState(false);
    savedScrollTopRef.current = 0;
    beginProgrammaticGuard();
    el.scrollTo({ top: 0, behavior: "smooth" });
  }, [beginProgrammaticGuard, scrollRef, setParkedState]);

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    clearProgrammaticGuard();
    setParkedState(true);
    savedScrollTopRef.current = null;
    el.scrollTop = el.scrollHeight;
    syncFromElement(el, false);
  }, [clearProgrammaticGuard, scrollRef, setParkedState, syncFromElement]);

  useEffect(() => {
    return () => {
      clearProgrammaticGuard();
      clearTimeout(introSettleTimerRef.current);
    };
  }, [clearProgrammaticGuard]);

  return { parked, isAtTop, scrollToBottom, scrollToTop, pinToBottom };
}
