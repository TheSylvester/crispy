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

import { useRef, useEffect, useCallback } from 'react';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';
import { useBlocksVisibleToolIds } from './BlocksVisibilityContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { RenderLocationProvider } from '../context/RenderLocationContext.js';
import { usePanelDispatch } from './PanelStateContext.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import type { RichBlock } from './types.js';

/** Threshold in px — auto-scroll when within this distance of the bottom */
const AUTO_SCROLL_THRESHOLD = 80;

export function BlocksToolPanel(): React.JSX.Element {
  const dispatch = usePanelDispatch();
  const visibleToolIds = useBlocksVisibleToolIds();
  const registry = useBlocksToolRegistry();
  const { setToolPanelWidthPx } = usePreferences();
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const prevVisibleRef = useRef<Set<string>>(new Set());

  // ---------------------------------------------------------------------------
  // Sync visibility changes into reducer
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const currentSet = new Set(visibleToolIds);
    const prevSet = prevVisibleRef.current;

    // Dispatch TOOL_ARRIVED for newly visible tools
    for (const id of visibleToolIds) {
      if (!prevSet.has(id)) {
        dispatch({ type: 'TOOL_ARRIVED', toolId: id });
        // Mark tools without results as actively streaming
        if (!registry.getResult(id)) {
          dispatch({ type: 'STREAM_STARTED', toolId: id });
        }
      }
    }

    // Dispatch TOOL_LEFT_VIEW for tools that left
    for (const id of prevSet) {
      if (!currentSet.has(id)) {
        dispatch({ type: 'TOOL_LEFT_VIEW', toolId: id });
      }
    }

    prevVisibleRef.current = currentSet;
  }, [visibleToolIds, dispatch, registry]);

  // ---------------------------------------------------------------------------
  // Auto-scroll
  // ---------------------------------------------------------------------------
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
  }, []);

  const handleScroll = useCallback(() => {
    wasNearBottomRef.current = isNearBottom();
  }, [isNearBottom]);

  useEffect(() => {
    if (wasNearBottomRef.current) {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
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
          {visibleToolIds.length} visible
        </span>
      </div>
      <div
        className="crispy-tool-panel__scroll"
        data-render-mode="blocks"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {visibleToolIds.length === 0 ? (
          <div className="crispy-tool-panel__empty">No tools in view</div>
        ) : (
          <RenderLocationProvider location="panel">
            {visibleToolIds.map(id => (
              <PanelTool key={id} toolId={id} />
            ))}
          </RenderLocationProvider>
        )}
      </div>
    </div>
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
