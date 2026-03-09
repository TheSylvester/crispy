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

    // First pass: collect visible line endpoints, tagging inline tools
    const Y_GROUP_THRESHOLD = 4; // px — inline icons on the same row
    const items: Array<{
      toolId: string;
      inline: boolean;
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
        inline: transcriptEl.classList.contains('crispy-blocks-tool--inline'),
        leftX: tRect.right,
        leftY: (tVisibleTop + tVisibleBottom) / 2 - titlebarHeight,
        rightX: pRect.left,
        rightY: (pVisibleTop + pVisibleBottom) / 2 - titlebarHeight,
      });
    }

    // Second pass: merge inline tools sharing the same transcript Y into
    // single connector lines, then sort and fan out as before.
    items.sort((a, b) => a.leftY - b.leftY);

    // Group consecutive inline items at the same Y
    const merged: typeof items = [];
    let i = 0;
    while (i < items.length) {
      const item = items[i];
      if (!item.inline) {
        merged.push(item);
        i++;
        continue;
      }
      // Collect all inline items at approximately the same Y
      const group = [item];
      let j = i + 1;
      while (j < items.length && items[j].inline &&
             Math.abs(items[j].leftY - item.leftY) <= Y_GROUP_THRESHOLD) {
        group.push(items[j]);
        j++;
      }
      // Merge: average the panel Y, use the leftmost X on transcript side
      const avgPanelY = group.reduce((s, g) => s + g.rightY, 0) / group.length;
      merged.push({
        toolId: group.map(g => g.toolId).join('+'),
        inline: true,
        leftX: Math.max(...group.map(g => g.leftX)),
        leftY: item.leftY, // all ~same Y
        rightX: Math.min(...group.map(g => g.rightX)),
        rightY: avgPanelY,
      });
      i = j;
    }

    // Fan out vertical segments near the panel edge.
    // First stop at 5rem from panel, each subsequent stop +1rem further out
    // (i.e. closer to transcript). If the gap is too small, use 1rem per step.
    const remPx = parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    ) || 16;
    const count = merged.length;
    const result: ConnectorPath[] = [];
    for (let k = 0; k < count; k++) {
      const { toolId, leftX, leftY, rightX, rightY } = merged[k];
      const gap = rightX - leftX;
      const baseOffset = 5 * remPx;
      const needed = baseOffset + (count - 1) * remPx;
      // If gap can't fit 5rem base, fall back to 1rem per step from panel
      const midX = gap >= needed
        ? rightX - baseOffset - (count - 1 - k) * remPx
        : rightX - (count - k) * remPx;
      const d = `M ${leftX},${leftY} H ${Math.max(midX, leftX + 8)} V ${rightY} H ${rightX}`;
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
        zIndex: 9999,
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
