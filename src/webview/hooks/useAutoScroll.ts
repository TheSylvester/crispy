/**
 * useAutoScroll — intent-driven scroll management.
 *
 * Single source of truth: `parked` boolean = "user wants to stay at bottom."
 *
 * Parked transitions:
 *   → true:  scrollToBottom click, message send (pinToBottom), session change,
 *            fork/remount, user manually scrolls to absolute bottom (<10px)
 *   → false: user scrolls UP past 100px from bottom (direction-gated)
 *
 * Asymmetric hysteresis (100px to unpark, 10px to re-park) prevents flapping.
 * Direction gating (only unpark on upward scroll) prevents smooth-scroll
 * animations from accidentally unparking.
 *
 * Auto-scroll: single ResizeObserver on .crispy-transcript-content. When parked
 * and content grew, instant-scroll to bottom. The spacer div inside the content
 * div means control panel size changes flow through naturally. The observer
 * reads parked via ref (not closure) to avoid resubscription on state change.
 *
 * Button visibility: scroll-to-bottom hidden when parked, scroll-to-top hidden
 * when already at top.
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
/** Quiet period (ms) after last content resize before playing intro scroll. */
const INTRO_SETTLE_MS = 200;

export interface UseAutoScrollOptions {
  sessionId: string | null;
  /** Ref to the scrollable container (.crispy-transcript) */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Extra signal to re-attach when the scroll container mounts (e.g. fork history preload). */
  remount?: boolean;
  /** Whether this tab is currently active — observers are disconnected when false. */
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

export function useAutoScroll(opts: UseAutoScrollOptions): UseAutoScrollReturn {
  const { sessionId, scrollRef, remount, isActiveTab = true } = opts;

  const [parked, setParked] = useState(true);
  const [isAtTop, setIsAtTop] = useState(true);

  // Ref mirror of parked — read by ResizeObserver callback to avoid
  // resubscribing the observer on every parked state change.
  const parkedRef = useRef(true);
  parkedRef.current = parked;

  const rafIdRef = useRef(0);
  // Track previous scrollTop to compute direction (up vs down).
  const lastScrollTopRef = useRef(0);
  // Track scrollHeight for the ResizeObserver grow-detection.
  const lastScrollHeightRef = useRef(0);

  // ── Session / fork reset → always park ────────────────────────────
  useEffect(() => {
    setParked(true);
    setIsAtTop(true);
    lastScrollTopRef.current = 0;
    lastScrollHeightRef.current = 0;
  }, [sessionId, remount]);

  // ── Scroll listener: unpark / re-park / isAtTop ───────────────────
  // Direction-gated: only unpark when scrolling UP. This prevents smooth
  // scroll animations (scrollToBottom) from generating intermediate events
  // that would accidentally unpark.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        if (!scrollRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        const distFromBottom = scrollHeight - scrollTop - clientHeight;
        const delta = scrollTop - lastScrollTopRef.current;
        lastScrollTopRef.current = scrollTop;

        // Only unpark on UPWARD scroll (delta < 0) past threshold.
        // Smooth scroll animations move downward (delta > 0), so they
        // never trigger unpark regardless of distance from bottom.
        if (delta < 0 && distFromBottom > UNPARK_THRESHOLD) {
          setParked(false);
        }
        // Re-park: user manually scrolled all the way back to bottom.
        else if (distFromBottom < REPARK_THRESHOLD) {
          setParked(true);
        }

        setIsAtTop(scrollTop < AT_TOP_THRESHOLD);
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafIdRef.current);
    };
  }, [sessionId, scrollRef, remount]);

  // ── Auto-scroll: single ResizeObserver on content div ─────────────
  // When parked and content grew (new entries, spacer resize from
  // --cp-height change), instant-scroll to bottom.
  // Reads parkedRef (not parked state) so this effect doesn't re-subscribe
  // on parked changes — one stable observer per session/mount.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    if (!isActiveTab) return;

    const contentEl = scrollEl.querySelector('.crispy-transcript-content');
    if (!contentEl) return;

    const observer = new ResizeObserver(() => {
      if (!scrollRef.current) return;
      const el = scrollRef.current;
      const newScrollHeight = el.scrollHeight;
      const grew = newScrollHeight > lastScrollHeightRef.current;
      lastScrollHeightRef.current = newScrollHeight;

      if (grew && parkedRef.current) {
        el.scrollTop = newScrollHeight;
        lastScrollTopRef.current = el.scrollTop;
      }
    });

    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [sessionId, scrollRef, remount, isActiveTab]);

  // ── User-initiated smooth scrolls (FAB clicks) ────────────────────
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setParked(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [scrollRef]);

  const scrollToTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: "smooth" });
  }, [scrollRef]);

  // ── pinToBottom — called on message send ───────────────────────────
  const pinToBottom = useCallback(() => {
    setParked(true);
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
  }, [scrollRef]);

  // ── Intro scroll: one-shot sweep on session switch ──────────────
  // When the user switches to a session (or fork/remount), once content
  // has settled (no resizes for INTRO_SETTLE_MS), jump one viewport above
  // the bottom and smooth-scroll down. Gives spatial orientation that
  // there's history above. Purely cosmetic — doesn't touch parked state.
  // Only fires for content taller than the viewport.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl || !sessionId) return;
    if (!isActiveTab) return;

    const contentEl = scrollEl.querySelector('.crispy-transcript-content');
    if (!contentEl) return;

    let settleTimer: ReturnType<typeof setTimeout>;
    let fired = false;

    const observer = new ResizeObserver(() => {
      if (fired) return;
      clearTimeout(settleTimer);
      // Keep content pinned to bottom during render cascade so user
      // doesn't see a flash of content at the top.
      scrollEl.scrollTop = scrollEl.scrollHeight;
      lastScrollTopRef.current = scrollEl.scrollTop;

      settleTimer = setTimeout(() => {
        if (fired || !scrollRef.current) return;
        fired = true;
        observer.disconnect();

        const el = scrollRef.current;
        const { scrollHeight, clientHeight } = el;

        // Only animate if content is taller than viewport.
        if (scrollHeight <= clientHeight) return;

        // Jump one viewport above the bottom, then smooth-scroll down.
        const jumpTo = Math.max(0, scrollHeight - clientHeight * 2);
        el.scrollTop = jumpTo;
        lastScrollTopRef.current = jumpTo;
        el.scrollTo({ top: scrollHeight, behavior: "smooth" });
      }, INTRO_SETTLE_MS);
    });

    observer.observe(contentEl);
    return () => {
      observer.disconnect();
      clearTimeout(settleTimer);
    };
  }, [sessionId, scrollRef, remount, isActiveTab]);

  return { parked, isAtTop, scrollToBottom, scrollToTop, pinToBottom };
}
