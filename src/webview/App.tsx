/**
 * App — Root component, layout shell with context providers
 *
 * Wraps the app in TransportProvider and SessionProvider, then renders
 * the two-column layout: sidebar (SessionSelector) + main (TranscriptViewer).
 * AppLayout lives inside providers so it can use context hooks for sidebar state.
 *
 * @module App
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Transport } from './transport.js';
import type { TransportKind } from './main.js';
import { TransportProvider } from './context/TransportContext.js';
import { EnvironmentProvider } from './context/EnvironmentContext.js';
import { SessionProvider, useSession } from './context/SessionContext.js';
import { FileIndexProvider } from './context/FileIndexContext.js';
import { PreferencesProvider, usePreferences } from './context/PreferencesContext.js';
import { SessionSelector } from './components/SessionSelector.js';
import { TranscriptViewer } from './components/TranscriptViewer.js';
import { TitleBar } from './components/TitleBar.js';
import { FilePanel } from './components/file-panel/FilePanel.js';
import { FilePanelProvider } from './context/FilePanelContext.js';
import { SessionStatusProvider, useSessionStatus } from './hooks/useSessionStatus.js';
import { isPerfMode, PerfOverlay, PerfProfiler } from './perf/index.js';

interface AppProps {
  transport: Transport;
  transportKind: TransportKind;
}

export function App({ transport, transportKind }: AppProps): React.JSX.Element {
  return (
    <TransportProvider transport={transport}>
      <EnvironmentProvider kind={transportKind}>
        <SessionProvider>
          <FileIndexProvider>
            <PreferencesProvider>
              <SessionStatusProvider>
                <PerfProfiler id="App">
                  <AppLayout />
                </PerfProfiler>
                {isPerfMode && <PerfOverlay />}
              </SessionStatusProvider>
            </PreferencesProvider>
          </FileIndexProvider>
        </SessionProvider>
      </EnvironmentProvider>
    </TransportProvider>
  );
}

// ============================================================================
// Tool panel sizing constants
// ============================================================================

/** Min tool panel width in px — below this the panel content is unusable */
const MIN_PANEL_PX = 350;
/** Max tool panel width in px — 60rem */
const MAX_PANEL_PX = 60 * 16; // 960px
/** Tool panel claims this fraction of the container */
const PANEL_RATIO = 0.38;
/** Below this container width panels switch to overlay mode */
const OVERLAY_BREAKPOINT_PX = 800;

// ============================================================================
// File panel sizing constants
// ============================================================================

/** Min file panel width in px */
const FILE_MIN_PX = 220;
/** Max file panel width in px */
const FILE_MAX_PX = 450;
/** File panel claims this fraction of the container */
const FILE_RATIO = 0.22;
/** Minimum main column width — enforced when both panels are open */
const MIN_MAIN_PX = 480;

function AppLayout(): React.JSX.Element {
  const {
    sidebarCollapsed, setSidebarCollapsed,
    toolPanelOpen, toolPanelWidthPx,
    filePanelOpen, filePanelWidthPx,
  } = usePreferences();
  const { selectedSessionId } = useSession();
  const { channelState } = useSessionStatus(selectedSessionId);
  const isStreaming = channelState === 'streaming';
  const layoutRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);

  const closeSidebar = useCallback(() => {
    setSidebarCollapsed(true);
  }, [setSidebarCollapsed]);

  // Track actual container width via ResizeObserver — handles VS Code
  // editor splits, terminal resize, and any other layout changes.
  useEffect(() => {
    const el = layoutRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(Math.round(entry.contentRect.width));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ---- Tool panel width ----
  const autoPx = Math.min(Math.max(Math.round(containerWidth * PANEL_RATIO), MIN_PANEL_PX), MAX_PANEL_PX);
  const panelPx = toolPanelWidthPx != null
    ? Math.min(Math.max(toolPanelWidthPx, MIN_PANEL_PX), MAX_PANEL_PX)
    : autoPx;
  const isOverlay = toolPanelOpen && containerWidth < OVERLAY_BREAKPOINT_PX;
  const toolPanelWidth = toolPanelOpen && !isOverlay ? panelPx : 0;

  // ---- File panel width ----
  const fileAutoPx = Math.min(Math.max(Math.round(containerWidth * FILE_RATIO), FILE_MIN_PX), FILE_MAX_PX);
  const filePanelPx = filePanelWidthPx != null
    ? Math.min(Math.max(filePanelWidthPx, FILE_MIN_PX), FILE_MAX_PX)
    : fileAutoPx;

  // Dual-panel constraint: if both panels open and main column would be too
  // narrow, the file panel auto-switches to overlay mode (tool panel stays
  // docked because it shows streaming tool output — primary workflow).
  const bothOpen = filePanelOpen && toolPanelOpen;
  const isFilePanelOverlay = filePanelOpen && (
    containerWidth < OVERLAY_BREAKPOINT_PX ||
    (bothOpen && filePanelPx + panelPx + MIN_MAIN_PX > containerWidth)
  );
  const filePanelWidth = filePanelOpen && !isFilePanelOverlay ? filePanelPx : 0;

  return (
    <div
      ref={layoutRef}
      className="crispy-layout"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'open'}
      data-tool-panel={toolPanelOpen ? (isOverlay ? 'overlay' : 'open') : 'collapsed'}
      data-file-panel={filePanelOpen ? (isFilePanelOverlay ? 'overlay' : 'open') : 'collapsed'}
      style={{
        '--tool-panel-width': `${toolPanelWidth}px`,
        '--tool-panel-actual-width': `${toolPanelOpen ? panelPx : 0}px`,
        '--file-panel-width': `${filePanelWidth}px`,
        '--file-panel-actual-width': `${filePanelOpen ? filePanelPx : 0}px`,
        '--right-panels-width': `${toolPanelWidth + filePanelWidth}px`,
        '--container-width': `${containerWidth}px`,
      } as React.CSSProperties}
    >
      <TitleBar />

      <FilePanelProvider>
        {/* File panel — right-side, stacks left of tool panel */}
        {filePanelOpen && <FilePanel />}

        <aside className="crispy-sidebar">
          <div className="crispy-sidebar__header">Sessions</div>
          <SessionSelector />
        </aside>

        {/* Backdrop — click-outside to close sidebar (only when open) */}
        {!sidebarCollapsed && (
          <div
            className="crispy-sidebar-backdrop"
            onClick={closeSidebar}
            aria-hidden="true"
          />
        )}

        <main className="crispy-main" data-streaming={isStreaming || undefined}>
          <TranscriptViewer />
        </main>
      </FilePanelProvider>
    </div>
  );
}
