/**
 * usePanelFLIP — FLIP animation for tool panel card reflows
 *
 * When cards enter/exit the panel (e.g. visibility filter changes on scroll),
 * surviving cards jump instantly to new positions. This hook animates that
 * layout shift using the FLIP technique:
 *
 *   F — snapshot each card's top position before update
 *   L — after React renders, measure new positions (Last)
 *   I — compute the delta and apply an inverse transform (Invert)
 *   P — animate back to natural position via WAAPI (Play)
 *
 * New cards get a staggered WAAPI entrance animation (fade-in + slide-up).
 * This is the single source of truth for panel entrance animations — the
 * CSS keyframe `crispy-panel-card-enter` has been removed to avoid conflicts.
 *
 * Cards are identified by `data-tool-id` on their root element, which is
 * centralized in ToolPanelCard (individual renderers don't need to add it).
 *
 * Respects `prefers-reduced-motion` — all animations are skipped when the
 * user has enabled reduced motion.
 *
 * @module webview/hooks/usePanelFLIP
 */

import { useRef, useLayoutEffect } from 'react';

/** Duration of the position tween in ms */
const FLIP_DURATION = 150;

/** Duration of the entrance animation in ms */
const ENTRANCE_DURATION = 200;

/** Stagger delay between successive new card entrances */
const ENTRANCE_STAGGER = 40;

/** Maximum total stagger delay (caps at ~3 cards worth) */
const MAX_STAGGER_DELAY = 120;

/**
 * Animate surviving cards to their new positions when the panel list changes.
 * New cards get a staggered entrance animation via WAAPI.
 *
 * @param scrollRef - ref to the panel's scroll container
 */
export function usePanelFLIP(
  scrollRef: React.RefObject<HTMLDivElement | null>,
): void {
  // Snapshot: tool-id → top position (viewport-relative)
  const prevRectsRef = useRef<Map<string, number>>(new Map());

  // Track previous ID string for cheap change detection
  const prevIdsRef = useRef<string>('');

  // Track running WAAPI animations for cancellation
  const animMapRef = useRef<Map<HTMLElement, Animation>>(new Map());

  // On every layout, apply FLIP to surviving cards, then snapshot for next time.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    // Respect reduced motion preference
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Still snapshot positions so things work when preference changes
      const nextRects = new Map<string, number>();
      const cards = Array.from(
        container.querySelectorAll<HTMLElement>(':scope > [data-tool-id]')
      );
      for (const card of cards) {
        const id = card.dataset.toolId;
        if (id) nextRects.set(id, card.getBoundingClientRect().top);
      }
      prevRectsRef.current = nextRects;
      prevIdsRef.current = cards.map(c => c.dataset.toolId).join(',');
      return;
    }

    const prevRects = prevRectsRef.current;
    const cards = Array.from(
      container.querySelectorAll<HTMLElement>(':scope > [data-tool-id]')
    );
    const currentIds = cards.map(c => c.dataset.toolId).join(',');

    // Early exit if no meaningful change (just re-renders without list changes)
    if (currentIds === prevIdsRef.current && prevRects.size > 0) {
      // Still update rects in case positions shifted (e.g. content height changes)
      const nextRects = new Map<string, number>();
      for (const card of cards) {
        const id = card.dataset.toolId;
        if (id) nextRects.set(id, card.getBoundingClientRect().top);
      }
      prevRectsRef.current = nextRects;
      return;
    }

    let newCardCount = 0;

    for (const card of cards) {
      const id = card.dataset.toolId;
      if (!id) continue;

      const prevTop = prevRects.get(id);
      const currentTop = card.getBoundingClientRect().top;

      if (prevTop !== undefined) {
        // --- Surviving card: FLIP ---
        const delta = prevTop - currentTop;
        if (Math.abs(delta) < 1) continue; // No meaningful movement

        // Cancel any in-flight animation on this element
        animMapRef.current.get(card)?.cancel();

        const anim = card.animate(
          [
            { transform: `translateY(${delta}px)` },
            { transform: 'translateY(0)' },
          ],
          { duration: FLIP_DURATION, easing: 'ease-out' },
        );

        animMapRef.current.set(card, anim);
        anim.finished.then(() => {
          if (animMapRef.current.get(card) === anim) {
            animMapRef.current.delete(card);
          }
        }).catch(() => {
          // Animation was cancelled — only clean up if still ours
          if (animMapRef.current.get(card) === anim) {
            animMapRef.current.delete(card);
          }
        });
      } else if (prevRects.size > 0) {
        // --- New card: staggered entrance (only when there were previous cards) ---
        // Cancel any in-flight animation
        animMapRef.current.get(card)?.cancel();

        const anim = card.animate(
          [
            { opacity: 0, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          {
            duration: ENTRANCE_DURATION,
            easing: 'ease-out',
            delay: Math.min(newCardCount * ENTRANCE_STAGGER, MAX_STAGGER_DELAY),
          },
        );

        animMapRef.current.set(card, anim);
        anim.finished.then(() => {
          if (animMapRef.current.get(card) === anim) {
            animMapRef.current.delete(card);
          }
        }).catch(() => {
          if (animMapRef.current.get(card) === anim) {
            animMapRef.current.delete(card);
          }
        });

        newCardCount++;
      }
    }

    // --- Snapshot for next render ---
    const nextRects = new Map<string, number>();
    for (const card of cards) {
      const id = card.dataset.toolId;
      if (id) {
        nextRects.set(id, card.getBoundingClientRect().top);
      }
    }
    prevRectsRef.current = nextRects;
    prevIdsRef.current = currentIds;
  });
}
