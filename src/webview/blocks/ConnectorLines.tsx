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
 * @module webview/blocks/ConnectorLines
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePanelDisplayIds } from './PanelStateContext.js';

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
  const [paths, setPaths] = useState<ConnectorPath[]>([]);
  const rafRef = useRef<number>(0);
  const settleRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const computePaths = useCallback(() => {
    const transcriptScroll = document.querySelector('.crispy-transcript');
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

    // First pass: collect visible line endpoints
    const items: Array<{
      toolId: string;
      leftX: number; leftY: number;
      rightX: number; rightY: number;
    }> = [];

    for (const toolId of panelDisplayIds) {
      const transcriptEl = transcriptScroll.querySelector(
        `.crispy-blocks-tool[data-tool-id="${toolId}"]`
      );
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

      items.push({
        toolId,
        leftX: tRect.right,
        leftY: (tVisibleTop + tVisibleBottom) / 2 - titlebarHeight,
        rightX: pRect.left,
        rightY: (pVisibleTop + pVisibleBottom) / 2 - titlebarHeight,
      });
    }

    // Second pass: sort by transcript Y so lines fan out top-to-bottom,
    // then spread each line's vertical segment into its own lane across
    // the gap. With N lines the lanes sit at 1/(N+1), 2/(N+1), … N/(N+1).
    items.sort((a, b) => a.leftY - b.leftY);
    const count = items.length;

    const result: ConnectorPath[] = [];
    for (let i = 0; i < count; i++) {
      const { toolId, leftX, leftY, rightX, rightY } = items[i];
      const t = count === 1 ? 0.5 : (i + 1) / (count + 1);
      const midX = leftX + (rightX - leftX) * t;
      const d = `M ${leftX},${leftY} H ${midX} V ${rightY} H ${rightX}`;
      result.push({ toolId, d });
    }

    setPaths(result);
  }, [panelDisplayIds]);

  // Schedule a rAF-guarded recompute — cancel-and-reschedule so the last
  // layout event always wins (avoids freezing on intermediate coordinates).
  // Also queues a delayed "settle" pass (~200ms) to catch post-animation
  // positions — VS Code animates editor layout changes, so the first rAF
  // often reads mid-transition coordinates.
  const scheduleUpdate = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      computePaths();
    });
    // Settle pass: recompute after CSS transitions finish
    clearTimeout(settleRef.current);
    settleRef.current = setTimeout(() => {
      requestAnimationFrame(computePaths);
    }, 200);
  }, [computePaths]);

  useEffect(() => {
    const transcriptScroll = document.querySelector('.crispy-transcript');
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

    // Window resize — catches viewport shifts from editor group rearrangement,
    // sidebar/terminal toggle, or VS Code panel moves.
    window.addEventListener('resize', scheduleUpdate);

    return () => {
      cancelled = true;
      transcriptScroll?.removeEventListener('scroll', scheduleUpdate);
      panelScroll?.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      resizeObserver?.disconnect();
      clearTimeout(settleRef.current);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [computePaths, scheduleUpdate]);

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
          stroke="var(--tint-strong)"
          strokeWidth="1.25"
        />
      ))}
    </svg>
  );
}
