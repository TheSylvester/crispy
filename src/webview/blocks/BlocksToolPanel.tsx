/**
 * Blocks Tool Panel — tool mirror panel for blocks mode
 *
 * Renders all visible tools from the transcript using the same
 * ToolBlockRenderer pipeline. Tools default to compact; only active
 * (streaming) tools render expanded. Task children nest inside their
 * parent Task tool exactly as in the transcript.
 *
 * Syncs with BlocksVisibilityContext to track which tools are in view.
 *
 * @module webview/blocks/BlocksToolPanel
 */

import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';
import { useBlocksVisibleToolIds, useBlocksLastArrivedToolId } from './BlocksVisibilityContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { useTabPanel } from '../context/TabPanelContext.js';
import { RenderLocationProvider } from '../context/RenderLocationContext.js';
import { usePanelState, usePanelDispatch, useSetPanelDisplayIds } from './PanelStateContext.js';
import { useTabContainer, useIsActiveTab } from '../context/TabContainerContext.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import { getToolRenderCategory } from './tool-definitions.js';
import type { RichBlock } from './types.js';

import type { RenderMode } from '../types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';

/** Threshold in px — auto-scroll when within this distance of the bottom */
const AUTO_SCROLL_THRESHOLD = 80;

/**
 * Format the inspector count label. In Icons mode, splits active (streaming)
 * from shown (completed inline tools) for clarity.
 */
function formatInspectorCount(
  ids: string[],
  registry: BlocksToolRegistry,
  renderMode: RenderMode,
): string {
  if (ids.length === 0) return 'idle';
  if (renderMode !== 'icons') return `${ids.length} active`;

  let active = 0;
  let shown = 0;
  for (const id of ids) {
    if (!registry.getResult(id)) {
      active++;
    } else {
      shown++;
    }
  }

  if (active > 0 && shown > 0) return `${active} active, ${shown} shown`;
  if (active > 0) return `${active} active`;
  return `${shown} shown`;
}

export function BlocksToolPanel(): React.JSX.Element {
  const dispatch = usePanelDispatch();
  const panelState = usePanelState();
  const visibleToolIds = useBlocksVisibleToolIds();
  const registry = useBlocksToolRegistry();
  const { toolPanelMode, setToolPanelMode, renderMode } = usePreferences();
  const { setToolPanelWidthPx, setToolPanelOpen } = useTabPanel();
  const lastArrivedId = useBlocksLastArrivedToolId();
  const { containerRef } = useTabContainer();
  const isActiveTab = useIsActiveTab();
  const _pendingGen = registry.usePendingCount(); // triggers re-render on pending changes
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const prevVisibleRef = useRef<Set<string>>(new Set());

  // ---------------------------------------------------------------------------
  // Inspector mode: compute filtered display list (without DOM queries)
  // ---------------------------------------------------------------------------
  const baseDisplayToolIds = useMemo(() => {
    if (toolPanelMode === 'viewport') return visibleToolIds;

    const ids: string[] = [];
    const seen = new Set<string>();

    // 1. Active tools (visible AND pending — no result yet)
    for (const id of visibleToolIds) {
      if (!registry.getResult(id)) {
        ids.push(id);
        seen.add(id);
      }
    }

    // 2. User-focused tools (userOverrides where value=true and block exists)
    for (const [id, expanded] of panelState.userOverrides) {
      const block = registry.getBlock(id);
      if (expanded && !seen.has(id) && block) {
        // Don't promote Task children to root panel entries
        if (block.context.parentToolUseId) continue;
        ids.push(id);
        seen.add(id);
      }
    }

    // 3. Last scrolled into view (spatial awareness)
    if (lastArrivedId && !seen.has(lastArrivedId)) {
      ids.push(lastArrivedId);
      seen.add(lastArrivedId);
    }

    return ids;
  }, [toolPanelMode, visibleToolIds, panelState.userOverrides, lastArrivedId, _pendingGen]);

  // ---------------------------------------------------------------------------
  // Icons mode Y-grouping: DOM measurement via rAF-backed effect
  // ---------------------------------------------------------------------------
  // Cached Y positions for tool elements, updated via requestAnimationFrame
  const toolYPositionsRef = useRef<Map<string, number>>(new Map());
  const [iconsGroupIds, setIconsGroupIds] = useState<string[]>([]);
  const rafIdRef = useRef<number>(0);

  // Determine if icons grouping is needed
  const needsIconsGrouping = renderMode === 'icons' && toolPanelMode !== 'viewport';

  useEffect(() => {
    if (!needsIconsGrouping) {
      if (iconsGroupIds.length > 0) setIconsGroupIds([]);
      return;
    }

    // Schedule DOM measurement in rAF to avoid layout thrashing during render
    rafIdRef.current = requestAnimationFrame(() => {
      const scrollRoot = containerRef.current?.querySelector('.crispy-transcript') as HTMLElement | null;
      if (!scrollRoot) return;

      // Update cached Y positions for all visible tools
      const yMap = new Map<string, number>();
      for (const id of visibleToolIds) {
        const el = scrollRoot.querySelector(`[data-run-id="${id}"]`);
        if (el) yMap.set(id, Math.round(el.getBoundingClientRect().top));
      }
      toolYPositionsRef.current = yMap;

      const baseSet = new Set(baseDisplayToolIds);
      const visibleSet = new Set(visibleToolIds);

      // Find anchor Y: prefer lastArrivedId if visible, else bottom-most visible inline
      let anchorY: number | null = null;

      if (lastArrivedId && visibleSet.has(lastArrivedId)) {
        anchorY = yMap.get(lastArrivedId) ?? null;
      }

      if (anchorY === null) {
        for (let i = visibleToolIds.length - 1; i >= 0; i--) {
          const id = visibleToolIds[i];
          const block = registry.getBlock(id);
          if (block && block.type === 'tool_use' && getToolRenderCategory(block.name) === 'inline') {
            const y = yMap.get(id);
            if (y !== undefined) {
              anchorY = y;
              break;
            }
          }
        }
      }

      // Collect Y positions of already-selected tools + the anchor
      const groupYs = new Set<number>();
      for (const id of baseDisplayToolIds) {
        const y = yMap.get(id);
        if (y !== undefined) groupYs.add(y);
      }
      if (anchorY !== null) groupYs.add(anchorY);

      // Find visible inline tools at those Y positions that aren't already in base
      const extras: string[] = [];
      for (const id of visibleToolIds) {
        if (baseSet.has(id)) continue;
        const block = registry.getBlock(id);
        if (!block || block.type !== 'tool_use') continue;
        if (getToolRenderCategory(block.name) !== 'inline') continue;

        const y = yMap.get(id);
        if (y !== undefined && groupYs.has(y)) {
          extras.push(id);
        }
      }

      setIconsGroupIds(prev => {
        if (prev.length === extras.length && prev.every((id, i) => id === extras[i])) return prev;
        return extras;
      });
    });

    return () => cancelAnimationFrame(rafIdRef.current);
  }, [needsIconsGrouping, visibleToolIds, baseDisplayToolIds, lastArrivedId, registry, containerRef]);

  // Merge base IDs with icons group IDs
  const displayToolIds = useMemo(() => {
    if (!needsIconsGrouping || iconsGroupIds.length === 0) return baseDisplayToolIds;
    // Append extras that aren't already in base
    const baseSet = new Set(baseDisplayToolIds);
    const merged = [...baseDisplayToolIds];
    for (const id of iconsGroupIds) {
      if (!baseSet.has(id)) merged.push(id);
    }
    return merged;
  }, [baseDisplayToolIds, iconsGroupIds, needsIconsGrouping]);

  // Publish display set so transcript-side ToolBlockRenderer can highlight.
  // Only clear on unmount — not on every dependency change — to avoid
  // double-publish (empty set then populated set) on each update.
  const setPanelDisplayIds = useSetPanelDisplayIds();
  const publishedSetRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const next = new Set(displayToolIds);
    const prev = publishedSetRef.current;
    // Shallow set equality check — skip publish if contents are identical
    if (next.size === prev.size) {
      let equal = true;
      for (const id of next) {
        if (!prev.has(id)) { equal = false; break; }
      }
      if (equal) return;
    }
    publishedSetRef.current = next;
    setPanelDisplayIds(next);
  }, [displayToolIds, setPanelDisplayIds]);

  // Clear display set only on unmount
  useEffect(() => {
    return () => setPanelDisplayIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Sync visibility changes into reducer
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const currentSet = new Set(visibleToolIds);
    const prevSet = prevVisibleRef.current;

    // Auto-expand newly visible tools that are still streaming (no result yet).
    // On session load, completed tools already have results → stay compact.
    for (const id of visibleToolIds) {
      if (!prevSet.has(id)) {
        if (!registry.getResult(id)) {
          dispatch({ type: 'AUTO_EXPAND', toolId: id });
        }
      }
    }

    // Dispatch TOOL_LEFT_VIEW for tools that left
    for (const id of prevSet) {
      if (!currentSet.has(id)) {
        // In inspector mode, preserve user overrides so pinned tools persist
        if (toolPanelMode === 'inspector' && panelState.userOverrides.has(id)) {
          continue;
        }
        dispatch({ type: 'TOOL_LEFT_VIEW', toolId: id });
      }
    }

    prevVisibleRef.current = currentSet;
  }, [visibleToolIds, dispatch, registry, toolPanelMode, panelState.userOverrides]);

  // ---------------------------------------------------------------------------
  // Auto-scroll
  // ---------------------------------------------------------------------------
  const lastScrollHeightRef = useRef(0);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
  }, []);

  const handleScroll = useCallback(() => {
    wasNearBottomRef.current = isNearBottom();
  }, [isNearBottom]);

  // ResizeObserver on the panel scroll content — catches all height changes:
  // card expansion, streaming content growth, new task children, etc.
  // Mirrors the proven pattern from useAutoScroll.ts (transcript scroll).
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    if (!isActiveTab) return;

    lastScrollHeightRef.current = scrollEl.scrollHeight;

    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (!el) return;
      const newScrollHeight = el.scrollHeight;
      const grew = newScrollHeight > lastScrollHeightRef.current;
      lastScrollHeightRef.current = newScrollHeight;

      if (grew && wasNearBottomRef.current) {
        el.scrollTop = newScrollHeight;
      }
    });

    // Observe the scroll container itself — its scrollHeight changes when
    // any child (tool card, task children, streaming output) grows.
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [visibleToolIds.length, isActiveTab]);

  // ---------------------------------------------------------------------------
  // Drag-to-resize
  // ---------------------------------------------------------------------------
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const panel = (e.target as HTMLElement).closest('.crispy-tool-panel');
    const startWidth = panel?.clientWidth ?? 350;
    const layout = panel?.closest('.crispy-tab-layout') ?? document.querySelector('.crispy-layout');

    layout?.setAttribute('data-resizing', '');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaPx = startX - moveEvent.clientX;
      setToolPanelWidthPx(Math.round(startWidth + deltaPx));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      layout?.removeAttribute('data-resizing');
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [setToolPanelWidthPx]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="crispy-tool-panel">
      <div
        className="crispy-tool-panel__resize-handle"
        onMouseDown={handleResizeStart}
      />
      <div className="crispy-tool-panel__header">
        <span className="crispy-tool-panel__title">TOOLS</span>
        <span className="crispy-tool-panel__count">
          {toolPanelMode === 'inspector'
            ? formatInspectorCount(displayToolIds, registry, renderMode)
            : `${visibleToolIds.length} visible`}
        </span>
        <button
          className={`crispy-tool-panel__mode-toggle${
            toolPanelMode === 'viewport' ? ' crispy-tool-panel__mode-toggle--viewport' : ''
          }`}
          onClick={() => setToolPanelMode(toolPanelMode === 'inspector' ? 'viewport' : 'inspector')}
          title={toolPanelMode === 'inspector'
            ? 'Switch to viewport mode (show all visible tools)'
            : 'Switch to inspector mode (show active tools only)'}
        >
          {toolPanelMode === 'inspector' ? <InspectorIcon /> : <ViewportIcon />}
        </button>
        <button
          className="crispy-tool-panel__close"
          onClick={() => setToolPanelOpen(false)}
          title="Close tools panel (Alt+T)"
        >
          <CloseIcon />
        </button>
      </div>
      <div
        className="crispy-tool-panel__scroll"
        data-render-mode="blocks"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {displayToolIds.length === 0 ? (
          <div className="crispy-tool-panel__empty">
            {toolPanelMode === 'inspector' ? 'No active tools' : 'No tools in view'}
          </div>
        ) : (
          <RenderLocationProvider location="panel">
            {displayToolIds.map(id => (
              <PanelTool key={id} toolId={id} />
            ))}
          </RenderLocationProvider>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Icons
// ============================================================================

/** Crosshair/target icon — inspector mode (focused inspection) */
function InspectorIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="5" />
      <line x1="8" y1="1" x2="8" y2="4" />
      <line x1="8" y1="12" x2="8" y2="15" />
      <line x1="1" y1="8" x2="4" y2="8" />
      <line x1="12" y1="8" x2="15" y2="8" />
    </svg>
  );
}

/** Close (✕) icon */
function CloseIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

/** Eye icon — viewport mode (see everything) */
function ViewportIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

// ============================================================================
// Panel Tool — renders a single tool via ToolBlockRenderer
// ============================================================================

/**
 * Renders a tool in the panel using the same ToolBlockRenderer pipeline
 * as the transcript. The `tool-panel` anchor drives selectView() to use
 * compact for completed tools and expanded for running tools.
 *
 * Task children render nested inside via useBlocksChildEntries (handled
 * internally by ToolBlockRenderer).
 */
function PanelTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const registry = useBlocksToolRegistry();
  const block = registry.useBlock(toolId);

  // Block not yet available (registry hasn't processed the entry yet)
  if (!block || block.type !== 'tool_use') {
    return null;
  }

  return (
    <div data-run-id={toolId} data-tool-name={block.name}>
      <ToolBlockRenderer
        block={block as RichBlock & { type: 'tool_use' }}
        anchor={{ type: 'tool-panel', toolId }}
        registry={registry}
        siblingCount={1}
      />
    </div>
  );
}
