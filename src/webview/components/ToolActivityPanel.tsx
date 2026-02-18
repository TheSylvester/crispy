/**
 * ToolActivityPanel v2 — Viewport-aware modular tool panel
 *
 * Three filter modes:
 * - **Visible** — IntersectionObserver-driven: only tools currently visible
 *   in the transcript viewport are shown, creating a synchronized "detail
 *   inspector" experience.
 * - **All** — every root tool (original behavior).
 * - **Active** — only tools with status: 'running'.
 *
 * Uses panel-optimized renderers via ToolPanelCard dispatch, which prefers
 * dedicated panel renderers (PanelBashTool, PanelEditTool, etc.) and falls
 * back to inline renderers for tools without a panel variant.
 *
 * Must be rendered inside ToolRegistryProvider (needs useToolRoots())
 * and VisibilityProvider (needs useVisibleToolIds()).
 *
 * @module ToolActivityPanel
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useToolRoots, useToolRegistry } from '../context/ToolRegistryContext.js';
import { useVisibleToolIds } from '../context/VisibilityContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { ToolPanelCard } from '../renderers/tools/panel/ToolPanelCard.js';

/** Filter modes for the tool panel */
type FilterMode = 'visible' | 'all' | 'active';

const FILTER_LABELS: Record<FilterMode, string> = {
  visible: 'Visible',
  all: 'All',
  active: 'Active',
};

const FILTER_MODES: FilterMode[] = ['visible', 'all', 'active'];

/** Threshold in px — auto-scroll when within this distance of the bottom */
const AUTO_SCROLL_THRESHOLD = 80;

export function ToolActivityPanel(): React.JSX.Element {
  const rootIds = useToolRoots();
  const visibleIds = useVisibleToolIds();
  const registry = useToolRegistry();
  const { setToolPanelWidthPx } = usePreferences();
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const [filterMode, setFilterMode] = useState<FilterMode>('visible');

  // --- Filter logic ---
  const displayIds = useMemo(() => {
    switch (filterMode) {
      case 'visible': {
        // Only show root-level tools that are visible in the transcript viewport.
        // visibleIds contains IDs of tool cards visible in the transcript;
        // we filter to root-level only (depth 0) since nested children are
        // rendered by their parent's panel renderer.
        const rootSet = new Set(rootIds);
        return visibleIds.filter(id => rootSet.has(id));
      }
      case 'active': {
        return rootIds.filter(id => {
          const entry = registry.getToolEntry(id);
          return entry?.status === 'running';
        });
      }
      case 'all':
      default:
        return rootIds;
    }
  }, [filterMode, rootIds, visibleIds, registry]);

  /** Check if the scroll container is near the bottom */
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
  }, []);

  /** Track scroll position — remember if we were near bottom before content changes */
  const handleScroll = useCallback(() => {
    wasNearBottomRef.current = isNearBottom();
  }, [isNearBottom]);

  /** Auto-scroll to bottom when new tools appear (if user was near bottom) */
  useEffect(() => {
    if (wasNearBottomRef.current) {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [displayIds.length]);

  /** Drag-to-resize: mousedown on the handle starts tracking.
   *  Computes new width in px from drag delta.
   *  Sets [data-resizing] on .crispy-layout to disable CSS transitions during drag. */
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const panel = (e.target as HTMLElement).closest('.crispy-tool-panel');
    const startWidth = panel?.clientWidth ?? 350;
    const layout = document.querySelector('.crispy-layout');

    layout?.setAttribute('data-resizing', '');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Panel is on the right — dragging left increases width
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

  // Empty state message depends on filter mode
  const emptyMessage = filterMode === 'visible'
    ? 'No tools visible in viewport'
    : filterMode === 'active'
      ? 'No active tools'
      : 'No tool activity yet';

  return (
    <div className="crispy-tool-panel">
      {/* Drag handle — left edge resize grip */}
      <div
        className="crispy-tool-panel__resize-handle"
        onMouseDown={handleResizeStart}
      />
      <div className="crispy-tool-panel__header">
        <span className="crispy-tool-panel__title">TOOLS</span>
        <div className="crispy-tool-panel__filters">
          {FILTER_MODES.map(mode => (
            <button
              key={mode}
              className={`crispy-tool-panel__filter-btn ${filterMode === mode ? 'crispy-tool-panel__filter-btn--active' : ''}`}
              onClick={() => setFilterMode(mode)}
              title={`Show ${FILTER_LABELS[mode].toLowerCase()} tools`}
            >
              {FILTER_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>
      <div
        className="crispy-tool-panel__scroll"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {displayIds.length === 0 ? (
          <div className="crispy-tool-panel__empty">{emptyMessage}</div>
        ) : (
          displayIds.map((id) => <ToolPanelCard key={id} toolId={id} />)
        )}
      </div>
    </div>
  );
}
