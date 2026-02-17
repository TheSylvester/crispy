/**
 * ToolActivityPanel — Right-side panel mirroring all root-level tool activity
 *
 * Renders the same ToolCard components used inline in the chat stream,
 * but in a dedicated scrollable panel. Auto-scrolls to bottom when near
 * the bottom edge (same UX as the main transcript).
 *
 * Includes a draggable left-edge resize handle. Drag sets an absolute px
 * override in preferences (clamped by AppLayout to MIN/MAX bounds).
 *
 * Must be rendered inside ToolRegistryProvider (needs useToolRoots()).
 *
 * @module ToolActivityPanel
 */

import { useRef, useEffect, useCallback } from 'react';
import { useToolRoots } from '../context/ToolRegistryContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { ToolCard } from '../renderers/tools/ToolCard.js';

/** Threshold in px — auto-scroll when within this distance of the bottom */
const AUTO_SCROLL_THRESHOLD = 80;

export function ToolActivityPanel(): React.JSX.Element {
  const rootIds = useToolRoots();
  const { toolPanelWidthPx, setToolPanelWidthPx } = usePreferences();
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

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
  }, [rootIds.length]);

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

  return (
    <div className="crispy-tool-panel">
      {/* Drag handle — left edge resize grip */}
      <div
        className="crispy-tool-panel__resize-handle"
        onMouseDown={handleResizeStart}
      />
      <div className="crispy-tool-panel__header">TOOLS</div>
      <div
        className="crispy-tool-panel__scroll"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {rootIds.length === 0 ? (
          <div className="crispy-tool-panel__empty">No tool activity yet</div>
        ) : (
          rootIds.map((id) => <ToolCard key={id} toolId={id} />)
        )}
      </div>
    </div>
  );
}
