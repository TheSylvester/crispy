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
import { usePanelDisplayIds, usePanelState } from './PanelStateContext.js';
import { useTabContainer, useIsActiveTab } from '../context/TabContainerContext.js';

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
  const panelState = usePanelState();
  const { containerRef } = useTabContainer();
  const isActiveTab = useIsActiveTab();
  const [paths, setPaths] = useState<ConnectorPath[]>([]);
  const rafRef = useRef<number>(0);
  const settleRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const computePaths = useCallback(() => {
    const transcriptScroll = containerRef.current?.querySelector('.crispy-transcript');
    const panelScroll = containerRef.current?.querySelector('.crispy-tool-panel__scroll');
    if (!transcriptScroll || !panelScroll) {
      setPaths([]);
      return;
    }

    const transcriptRect = transcriptScroll.getBoundingClientRect();
    const panelRect = panelScroll.getBoundingClientRect();

    // Get the tab container's viewport offset — SVG is absolutely positioned
    // within .crispy-tab-layout, so all coordinates must be container-relative.
    const container = containerRef.current?.closest('.crispy-tab-layout');
    const containerRect = container?.getBoundingClientRect();
    const offsetX = containerRect?.left ?? 0;
    const offsetY = containerRect?.top ?? 0;

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
        leftX: tRect.right - offsetX,
        leftY: (tVisibleTop + tVisibleBottom) / 2 - offsetY,
        rightX: pRect.left - offsetX,
        rightY: (pVisibleTop + pVisibleBottom) / 2 - offsetY,
      });
    }

    // Second pass: normalize inline tools sharing the same transcript Y so
    // they share a common left endpoint (the icon group's right edge).
    // Each tool keeps its own right endpoint → the fan-out algorithm draws
    // individual lines that split from one point to each panel card.
    items.sort((a, b) => a.leftY - b.leftY);

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
      // Normalize: all group members share the same left X/Y (rightmost
      // icon edge, first item's Y) but keep their individual panel endpoints.
      const sharedLeftX = Math.max(...group.map(g => g.leftX));
      const sharedLeftY = item.leftY;
      const sharedRightX = Math.min(...group.map(g => g.rightX));
      for (const g of group) {
        merged.push({
          ...g,
          leftX: sharedLeftX,
          leftY: sharedLeftY,
          rightX: sharedRightX,
        });
      }
      i = j;
    }

    // Build paths. Inline groups get a single shared horizontal trunk from
    // the icon group to a split point, then individual vertical→horizontal
    // legs to each panel card. Non-inline items get simple stepped lines.
    // The split point is 2rem from the panel edge; each additional line in
    // the group fans out 1rem further.
    const remPx = parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    ) || 16;
    const result: ConnectorPath[] = [];

    // Walk merged items, detecting inline groups (consecutive items with
    // same leftY, which we normalized above).
    let k = 0;
    while (k < merged.length) {
      const cur = merged[k];

      // Non-inline: simple stepped line
      if (!cur.inline) {
        const midX = Math.max(cur.rightX - 2 * remPx, cur.leftX + 8);
        const d = `M ${cur.leftX},${cur.leftY} H ${midX} V ${cur.rightY} H ${cur.rightX}`;
        result.push({ toolId: cur.toolId, d });
        k++;
        continue;
      }

      // Inline group: collect all consecutive items at the same leftY
      const group = [cur];
      let g = k + 1;
      while (g < merged.length && merged[g].inline &&
             Math.abs(merged[g].leftY - cur.leftY) <= Y_GROUP_THRESHOLD) {
        group.push(merged[g]);
        g++;
      }

      // Single split point for the whole group — 2rem from panel
      const splitX = Math.max(cur.rightX - 2 * remPx, cur.leftX + 8);

      if (group.length === 1) {
        // Solo inline tool — simple stepped line
        const d = `M ${cur.leftX},${cur.leftY} H ${splitX} V ${cur.rightY} H ${cur.rightX}`;
        result.push({ toolId: cur.toolId, d });
      } else {
        // Shared trunk: one horizontal line from icon group to split point.
        // Then per-tool legs: vertical from split point to each panel Y,
        // then horizontal to the panel card.
        // Draw the trunk as part of each tool's path so all paths are
        // self-contained (the overlapping trunk renders as one line visually).
        for (const member of group) {
          const d = `M ${member.leftX},${member.leftY} H ${splitX} V ${member.rightY} H ${member.rightX}`;
          result.push({ toolId: member.toolId, d });
        }
      }

      k = g;
    }

    setPaths(result);
  }, [panelDisplayIds, containerRef]);

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
    if (!isActiveTab) return;

    const transcriptScroll = containerRef.current?.querySelector('.crispy-transcript');
    const panelScroll = containerRef.current?.querySelector('.crispy-tool-panel__scroll');
    const layout = containerRef.current?.closest('.crispy-tab-layout') ?? containerRef.current?.querySelector('.crispy-layout');

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
  }, [computePaths, scheduleUpdate, containerRef, isActiveTab]);

  // Re-compute when panelDisplayIds changes
  useEffect(() => {
    computePaths();
  }, [panelDisplayIds, computePaths]);

  // Re-compute when expand/collapse state changes — use scheduleUpdate
  // (with settle pass) since the DOM needs to re-render with new card heights
  useEffect(() => {
    scheduleUpdate();
  }, [panelState, scheduleUpdate]);

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
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 150,
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
