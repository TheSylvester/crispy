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

import { useRef, useEffect, useCallback, useMemo } from 'react';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';
import { useBlocksVisibleToolIds, useBlocksLastArrivedToolId } from './BlocksVisibilityContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { RenderLocationProvider } from '../context/RenderLocationContext.js';
import { usePanelState, usePanelDispatch, useSetPanelDisplayIds } from './PanelStateContext.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import type { RichBlock } from './types.js';

/** Threshold in px — auto-scroll when within this distance of the bottom */
const AUTO_SCROLL_THRESHOLD = 80;

export function BlocksToolPanel(): React.JSX.Element {
  const dispatch = usePanelDispatch();
  const panelState = usePanelState();
  const visibleToolIds = useBlocksVisibleToolIds();
  const registry = useBlocksToolRegistry();
  const { toolPanelMode, setToolPanelMode, setToolPanelWidthPx, setToolPanelOpen } = usePreferences();
  const lastArrivedId = useBlocksLastArrivedToolId();
  const _pendingGen = registry.usePendingCount(); // triggers re-render on pending changes
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const prevVisibleRef = useRef<Set<string>>(new Set());

  // ---------------------------------------------------------------------------
  // Inspector mode: compute filtered display list
  // ---------------------------------------------------------------------------
  const displayToolIds = useMemo(() => {
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

  // Publish display set so transcript-side ToolBlockRenderer can highlight
  const setPanelDisplayIds = useSetPanelDisplayIds();
  useEffect(() => {
    setPanelDisplayIds(new Set(displayToolIds));
    return () => setPanelDisplayIds(new Set());
  }, [displayToolIds, setPanelDisplayIds]);

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
  }, [visibleToolIds.length]);

  // ---------------------------------------------------------------------------
  // Drag-to-resize
  // ---------------------------------------------------------------------------
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const panel = (e.target as HTMLElement).closest('.crispy-tool-panel');
    const startWidth = panel?.clientWidth ?? 350;
    const layout = document.querySelector('.crispy-layout');

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
            ? (displayToolIds.length === 0 ? 'idle' : `${displayToolIds.length} active`)
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
