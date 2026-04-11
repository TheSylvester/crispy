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
/** How long a user scroll gesture suppresses ResizeObserver auto-pin.
 *  Must be long enough for the scroll event to fire and evaluate unpark
 *  after the user's wheel/touch, but short enough to not delay re-park
 *  when the user stops scrolling near the bottom. */
const USER_SCROLL_SUPPRESS_MS = 400;

export interface UseAutoScrollOptions {
  sessionId: string | null;
  /** Ref to the scrollable container (.crispy-transcript) */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Extra signal to re-attach when the scroll container mounts (e.g. fork history preload). */
  remount?: boolean;
  /** When false, detach observers/listeners so hidden tabs don't corrupt scroll state. */
  isVisible?: boolean;
  /** Skip intro animation for observer-mode (autoClose) tabs. */
  observerMode?: boolean;
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
  const { sessionId, scrollRef, remount, isVisible = true, observerMode = false } = opts;

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
  // Deadline (performance.now) until which ResizeObserver must not auto-pin.
  // Set by wheel/touch/pointerdown so the user's scroll event has time to
  // evaluate unpark before a resize snaps them back to bottom.
  const userScrollSuppressUntilRef = useRef(0);

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
    userScrollSuppressUntilRef.current = 0;
    setParkedState(true);
    setIsAtTop(true);
    savedScrollTopRef.current = null;
    introPlayedForRef.current = null;
  }, [clearProgrammaticGuard, remount, sessionId, setParkedState]);

  // ── Scroll listener — only attached for the active tab ─────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isVisible) return;

    const onScroll = () => {
      const currentEl = scrollRef.current;
      if (!currentEl || currentEl.clientHeight === 0) return;
      syncFromElement(currentEl, !programmaticScrollRef.current);
    };

    const cancelProgrammaticScroll = () => {
      clearProgrammaticGuard();
      // Suppress ResizeObserver auto-pin so the user's scroll event has
      // time to travel past UNPARK_THRESHOLD before a resize snaps back.
      userScrollSuppressUntilRef.current = performance.now() + USER_SCROLL_SUPPRESS_MS;
    };

    const onScrollEnd = () => {
      clearProgrammaticGuard();
      userScrollSuppressUntilRef.current = 0;
      if (scrollRef.current && scrollRef.current.clientHeight > 0) {
        // Evaluate honestly — this is the final resting position after the
        // user's gesture, so allow unpark if they scrolled far enough.
        syncFromElement(scrollRef.current, true);
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
  }, [clearProgrammaticGuard, isVisible, remount, scrollRef, sessionId, syncFromElement]);

  // ── ResizeObserver: content growth, viewport resize, AND visibility
  // When the tab transitions from display:none to visible, the scroll
  // container goes from 0×0 to real dimensions — the observer fires.
  // We detect this transition and restore/pin scroll position.
  //
  // Gated on isVisible so hidden tabs don't attach observers that
  // corrupt scroll state during multi-tab mount races.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl || !isVisible) return;

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
            beginProgrammaticGuard();
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
      // Skip auto-pin while the user is actively scrolling — otherwise the
      // ResizeObserver re-arms the guard before the scroll event can unpark.
      const suppressAutoPin = performance.now() < userScrollSuppressUntilRef.current;
      if (parkedRef.current && !suppressAutoPin) {
        // Guard against the scroll event that fires from this assignment.
        // Without the guard, rapidly changing dimensions during streaming
        // can cause distFromBottom > UNPARK_THRESHOLD between the assignment
        // and the scroll handler, accidentally unparking the user.
        beginProgrammaticGuard();
        el.scrollTop = el.scrollHeight;
        savedScrollTopRef.current = null;

        // Intro scroll: after content stops growing for 250ms, start
        // one viewport above the bottom and smooth-scroll down. Gives
        // spatial context that there's history above. One-shot per session.
        // Skip for observer-mode tabs — they're background child sessions
        // where the peek animation adds no value and can corrupt scroll state.
        if (!observerMode && sessionId && introPlayedForRef.current !== sessionId) {
          clearTimeout(introSettleTimerRef.current);
          introSettleTimerRef.current = setTimeout(() => {
            if (!scrollRef.current || introPlayedForRef.current === sessionId) return;
            const target = scrollRef.current;
            // Check visibility BEFORE marking as played so a hidden tab
            // doesn't consume the one-shot without actually animating.
            if (!parkedRef.current || target.clientHeight === 0) return;
            introPlayedForRef.current = sessionId;
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
      // Reset visibility tracking on teardown so re-activation always
      // sees a clean hidden→visible transition instead of stale state.
      wasVisibleRef.current = false;
      savedScrollTopRef.current = null;
    };
  }, [beginProgrammaticGuard, isVisible, observerMode, remount, scrollRef, sessionId, syncFromElement]);

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

    setParkedState(true);
    savedScrollTopRef.current = null;
    el.scrollTop = el.scrollHeight;
    // Guard against the async scroll event racing with content growth.
    // Without this, React can render new entries (e.g. the user's own message)
    // between the scrollTop assignment and the scroll handler, causing
    // distFromBottom > UNPARK_THRESHOLD → spurious unpark.
    beginProgrammaticGuard();
    syncFromElement(el, false);
  }, [beginProgrammaticGuard, scrollRef, setParkedState, syncFromElement]);

  useEffect(() => {
    return () => {
      clearProgrammaticGuard();
      clearTimeout(introSettleTimerRef.current);
    };
  }, [clearProgrammaticGuard]);

  return { parked, isAtTop, scrollToBottom, scrollToTop, pinToBottom };
}
