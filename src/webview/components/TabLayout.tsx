/**
 * TabLayout — per-tab panel layout computation wrapper
 *
 * Owns the panel width computation and CSS custom properties that were
 * previously in AppLayout. Each tab gets its own layout container with
 * independent panel sizing, data attributes, and --content-top offset.
 *
 * @module TabLayout
 */

import { useEffect, useRef, useState } from 'react';
import { useTabPanel } from '../context/TabPanelContext.js';
import { useFilePanel } from '../context/FilePanelContext.js';
import { useControlPanel } from '../context/ControlPanelContext.js';
import { useTabSession } from '../context/TabSessionContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';

// ============================================================================
// Sizing constants (moved from App.tsx)
// ============================================================================

const MIN_PANEL_PX = 350;
const MAX_TOOL_PANEL_PX = 54 * 16; // 864px
const MAX_FILE_VIEWER_PX = 63 * 16; // 1008px
const TOOL_PANEL_RATIO = 0.30;
const FILE_VIEWER_RATIO = 0.35;
const OVERLAY_BREAKPOINT_PX = 800;
const DUAL_PANEL_BREAKPOINT_PX = 1100;

// ============================================================================
// Component
// ============================================================================

export function TabLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { toolPanelOpen, toolPanelWidthPx, fileViewerWidthPx } = useTabPanel();
  const { fileViewerOpen } = useFilePanel();
  const { agencyMode } = useControlPanel();
  const { effectiveSessionId } = useTabSession();
  const { channelState } = useSessionStatus(effectiveSessionId);
  const isStreaming = channelState === 'streaming';

  const layoutRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);
  const [contentTop, setContentTop] = useState(0);

  // ResizeObserver for container width + content-top offset
  useEffect(() => {
    const el = layoutRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setContainerWidth(Math.round(el.getBoundingClientRect().width));
      setContentTop(Math.round(el.getBoundingClientRect().top));
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

  // ---- File viewer panel width ----
  const fileViewerAutoPx = Math.min(Math.max(Math.round(containerWidth * FILE_VIEWER_RATIO), MIN_PANEL_PX), MAX_FILE_VIEWER_PX);
  const fileViewerPx = fileViewerWidthPx != null
    ? Math.min(Math.max(fileViewerWidthPx, MIN_PANEL_PX), MAX_FILE_VIEWER_PX)
    : fileViewerAutoPx;
  const isFileViewerOverlay = fileViewerOpen && (
    containerWidth < OVERLAY_BREAKPOINT_PX ||
    (toolPanelOpen && containerWidth < DUAL_PANEL_BREAKPOINT_PX)
  );
  const fileViewerWidth = fileViewerOpen && !isFileViewerOverlay ? fileViewerPx : 0;

  const rightPanelsWidth = toolPanelWidth + fileViewerWidth;

  const fileViewerState = fileViewerOpen
    ? (isFileViewerOverlay ? 'overlay' : 'open')
    : 'collapsed';

  return (
    <div
      ref={layoutRef}
      className="crispy-tab-layout"
      data-tool-panel={toolPanelOpen ? (isSidebarOverlay ? 'overlay' : 'open') : 'collapsed'}
      data-file-viewer={fileViewerState}
      data-agency={agencyMode}
      data-streaming={isStreaming || undefined}
      style={{
        '--tool-panel-width': `${toolPanelWidth}px`,
        '--tool-panel-actual-width': `${toolPanelOpen ? panelPx : 0}px`,
        '--file-viewer-width': `${fileViewerOpen ? fileViewerPx : 0}px`,
        '--right-panels-width': `${rightPanelsWidth}px`,
        '--container-width': `${containerWidth}px`,
        '--content-top': `${contentTop}px`,
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
