/**
 * TabLayout — per-tab panel layout computation wrapper
 *
 * Owns the panel width computation and CSS custom properties that were
 * previously in AppLayout. Each tab gets its own layout container with
 * independent panel sizing and data attributes.
 *
 * @module TabLayout
 */

import { useEffect, useRef, useState } from 'react';
import { useTabPanel } from '../context/TabPanelContext.js';
import { useControlPanel } from '../context/ControlPanelContext.js';
import { useTabSession } from '../context/TabSessionContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';

// ============================================================================
// Sizing constants (moved from App.tsx)
// ============================================================================

const MIN_PANEL_PX = 350;
const MAX_TOOL_PANEL_PX = 54 * 16; // 864px
const TOOL_PANEL_RATIO = 0.30;
const OVERLAY_BREAKPOINT_PX = 800;

// ============================================================================
// Component
// ============================================================================

export function TabLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { toolPanelOpen, toolPanelWidthPx } = useTabPanel();
  const { agencyMode } = useControlPanel();
  const { effectiveSessionId } = useTabSession();
  const { channelState } = useSessionStatus(effectiveSessionId);
  const isStreaming = channelState === 'streaming';

  const layoutRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);

  // ResizeObserver for container width (used for panel breakpoint calculations).
  // IMPORTANT: use borderBoxSize (full element width) not contentRect.width.
  // contentRect excludes padding, and padding-right is animated when the tool
  // panel opens. Reading contentRect during that transition causes a feedback
  // loop: shrinking content → overlay breakpoint → padding removed → content
  // grows → breakpoint un-triggers → rapid oscillation.
  useEffect(() => {
    const el = layoutRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const bbs = entry.borderBoxSize?.[0];
      const w = bbs ? Math.round(bbs.inlineSize) : Math.round(entry.contentRect.width);
      setContainerWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---- Tool/sidebar panel width ----
  const autoPx = Math.min(Math.max(Math.round(containerWidth * TOOL_PANEL_RATIO), MIN_PANEL_PX), MAX_TOOL_PANEL_PX);
  const panelPx = toolPanelWidthPx != null
    ? Math.min(Math.max(toolPanelWidthPx, MIN_PANEL_PX), MAX_TOOL_PANEL_PX)
    : autoPx;
  const isSidebarOverlay = toolPanelOpen && containerWidth < OVERLAY_BREAKPOINT_PX;
  const toolPanelWidth = toolPanelOpen && !isSidebarOverlay ? panelPx : 0;

  return (
    <div
      ref={layoutRef}
      className="crispy-tab-layout"
      data-tool-panel={toolPanelOpen ? (isSidebarOverlay ? 'overlay' : 'open') : 'collapsed'}
      data-agency={agencyMode}
      data-streaming={isStreaming || undefined}
      style={{
        '--tool-panel-width': `${toolPanelWidth}px`,
        '--tool-panel-actual-width': `${toolPanelOpen ? panelPx : 0}px`,
        '--right-panels-width': `${toolPanelWidth}px`,
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
