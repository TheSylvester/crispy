/**
 * Connector Lines — SVG stepped connector lines between transcript and tool panel
 *
 * Draws three-segment stepped lines (horizontal → vertical → horizontal) that
 * visually bridge each matched pair of tool cards: the transcript-side card on
 * the left and the corresponding tool panel card on the right.
 *
 * Lines are Y-clamped to each tool's visible portion within its scroll container,
 * so tools scrolled out of view produce no line. During panel resize drag,
 * lines are hidden via CSS (`[data-resizing] .crispy-connector-lines`).
 *
 * Does NOT modify or extend any frozen layers. Reads panelDisplayIds from
 * PanelStateContext (read-only).
 *
 * Uses bridge context for scrollRef to find the active tab's transcript scroll
 * container (since there may be multiple tabs with .crispy-transcript elements).
 *
 * @module webview/blocks/ConnectorLines
 */

import { useState, useEffect, useCallback, useRef, useContext } from 'react';
import { usePanelDisplayIds } from './PanelStateContext.js';
import { ActiveTabBlocksCtx } from './ActiveTabBlocksContext.js';

// ============================================================================
// Types
// ============================================================================

interface ConnectorPath {
  toolId: string;
  d: string;
}

// ============================================================================
// Hook: useConnectorPaths
// ============================================================================

function useConnectorPaths(): ConnectorPath[] {
  const panelDisplayIds = usePanelDisplayIds();
  const bridge = useContext(ActiveTabBlocksCtx);
  const [paths, setPaths] = useState<ConnectorPath[]>([]);
  const rafRef = useRef<number>(0);

  const computePaths = useCallback(() => {
    // Use bridge scrollRef for the active tab's transcript container
    // (global document.querySelector would find the first tab, not necessarily active)
    const transcriptScroll = bridge?.scrollRef?.current ?? null;
    const panelScroll = document.querySelector('.crispy-tool-panel__scroll');
    if (!transcriptScroll || !panelScroll) {
      setPaths([]);
      return;
    }

    const transcriptRect = transcriptScroll.getBoundingClientRect();
    const panelRect = panelScroll.getBoundingClientRect();

    // Get titlebar offset — the SVG top is at var(--titlebar-height)
    const titlebarHeight = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height')
    ) || 36;

    const result: ConnectorPath[] = [];

    for (const toolId of panelDisplayIds) {
      // Find transcript-side element
      const transcriptEl = transcriptScroll.querySelector(
        `.crispy-blocks-tool[data-tool-id="${toolId}"]`
      );
      // Find panel-side element
      const panelEl = panelScroll.querySelector(
        `[data-run-id="${toolId}"]`
      );

      if (!transcriptEl || !panelEl) continue;

      const tRect = transcriptEl.getBoundingClientRect();
      const pRect = panelEl.getBoundingClientRect();

      // Y-clamp: compute visible vertical center within each scroll container
      const tVisibleTop = Math.max(tRect.top, transcriptRect.top);
      const tVisibleBottom = Math.min(tRect.bottom, transcriptRect.bottom);
      if (tVisibleBottom <= tVisibleTop) continue; // scrolled out

      const pVisibleTop = Math.max(pRect.top, panelRect.top);
      const pVisibleBottom = Math.min(pRect.bottom, panelRect.bottom);
      if (pVisibleBottom <= pVisibleTop) continue; // scrolled out

      const leftY = (tVisibleTop + tVisibleBottom) / 2 - titlebarHeight;
      const rightY = (pVisibleTop + pVisibleBottom) / 2 - titlebarHeight;

      const leftX = tRect.right;
      const rightX = pRect.left;
      const midX = (leftX + rightX) / 2;

      // Three-segment stepped path: H → V → H
      const d = `M ${leftX},${leftY} H ${midX} V ${rightY} H ${rightX}`;
      result.push({ toolId, d });
    }

    setPaths(result);
  }, [panelDisplayIds, bridge?.scrollRef]);

  // Schedule a rAF-guarded recompute
  const scheduleUpdate = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      computePaths();
    });
  }, [computePaths]);

  useEffect(() => {
    // Use bridge scrollRef for the active tab's transcript container
    const transcriptScroll = bridge?.scrollRef?.current ?? null;
    const panelScroll = document.querySelector('.crispy-tool-panel__scroll');
    const layout = document.querySelector('.crispy-layout');

    // Initial compute — double-rAF to ensure layout has settled after mount
    let cancelled = false;
    requestAnimationFrame(() => {
      if (!cancelled) requestAnimationFrame(() => { if (!cancelled) computePaths(); });
    });

    // Scroll listeners (passive)
    const scrollOpts: AddEventListenerOptions = { passive: true };
    transcriptScroll?.addEventListener('scroll', scheduleUpdate, scrollOpts);
    panelScroll?.addEventListener('scroll', scheduleUpdate, scrollOpts);

    // Resize observer on layout
    let resizeObserver: ResizeObserver | undefined;
    if (layout) {
      resizeObserver = new ResizeObserver(scheduleUpdate);
      resizeObserver.observe(layout);
    }

    return () => {
      cancelled = true;
      transcriptScroll?.removeEventListener('scroll', scheduleUpdate);
      panelScroll?.removeEventListener('scroll', scheduleUpdate);
      resizeObserver?.disconnect();
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [computePaths, scheduleUpdate, bridge?.scrollRef]);

  // Re-compute when panelDisplayIds changes
  useEffect(() => {
    computePaths();
  }, [panelDisplayIds, computePaths]);

  return paths;
}

// ============================================================================
// Component
// ============================================================================

export function ConnectorLines(): React.JSX.Element | null {
  const paths = useConnectorPaths();

  if (paths.length === 0) return null;

  return (
    <svg
      className="crispy-connector-lines"
      style={{
        position: 'fixed',
        top: 'var(--titlebar-height, 36px)',
        left: 0,
        width: '100vw',
        height: 'calc(100vh - var(--titlebar-height, 36px))',
        pointerEvents: 'none',
        zIndex: 99,
      }}
    >
      {paths.map(({ toolId, d }) => (
        <path
          key={toolId}
          d={d}
          fill="none"
          stroke="rgba(255,255,255,0.2)"
          strokeWidth="1.25"
        />
      ))}
    </svg>
  );
}
