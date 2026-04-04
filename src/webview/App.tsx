/**
 * App — Root component, layout shell with context providers
 *
 * Wraps the app in TransportProvider and SessionProvider, then renders
 * the two-column layout: sidebar (SessionSelector) + main (TranscriptViewer).
 * AppLayout lives inside providers so it can use context hooks for sidebar state.
 *
 * @module App
 */

import { useEffect, useRef, useState } from 'react';
import type { Transport } from './transport.js';
import type { TransportKind } from './main.js';
import { TransportProvider } from './context/TransportContext.js';
import { EnvironmentProvider, useEnvironment } from './context/EnvironmentContext.js';
import { SessionProvider, useSession } from './context/SessionContext.js';
import { PreferencesProvider, usePreferences } from './context/PreferencesContext.js';
// FilePanel is now per-tab; app-level reads come from ActiveTabPanel bridge
import { FlexAppLayout } from './components/FlexAppLayout.js';
import { TitleBar } from './components/TitleBar.js';
import { SessionStatusProvider, useSessionStatus } from './hooks/useSessionStatus.js';
// ContentErrorBoundary moved per-tab (FlexAppLayout)
import { isPerfMode, PerfOverlay, PerfProfiler } from './perf/index.js';
import { ActiveTabAgencyProvider, useActiveTabAgency } from './context/ActiveTabAgencyContext.js';
import { ActiveTabPanelBridgeProvider, useActiveTabPanel } from './context/TabPanelContext.js';
import { TrackerToast } from './components/notifications/TrackerToast.js';
import { WorkspacePicker } from './components/WorkspacePicker.js';

interface AppProps {
  transport: Transport;
  transportKind: TransportKind;
}

export function App({ transport, transportKind }: AppProps): React.JSX.Element {
  return (
    <TransportProvider transport={transport}>
      <EnvironmentProvider kind={transportKind}>
        <SessionProvider>
            <PreferencesProvider>
              <SessionStatusProvider>
                <ActiveTabPanelBridgeProvider>
                <PerfProfiler id="App">
                  <AppLayout />
                </PerfProfiler>
                </ActiveTabPanelBridgeProvider>
                {isPerfMode && <PerfOverlay />}
                <TrackerToast />
              </SessionStatusProvider>
            </PreferencesProvider>
        </SessionProvider>
      </EnvironmentProvider>
    </TransportProvider>
  );
}

// ============================================================================
// Tool panel sizing constants
// ============================================================================

/** Min panel width in px — below this the panel content is unusable */
const MIN_PANEL_PX = 350;
/** Max tool panel width in px — ~54rem */
const MAX_TOOL_PANEL_PX = 54 * 16; // 864px
/** Max file viewer width in px — ~63rem */
const MAX_FILE_VIEWER_PX = 63 * 16; // 1008px
/** Tool panel claims this fraction of the container */
const TOOL_PANEL_RATIO = 0.30;
/** File viewer claims this fraction of the container */
const FILE_VIEWER_RATIO = 0.35;
/** Below this container width panels switch to overlay mode */
const OVERLAY_BREAKPOINT_PX = 800;

/** Breakpoint: both sidebar + file viewer get layout space */
const DUAL_PANEL_BREAKPOINT_PX = 1100;

function AppLayout(): React.JSX.Element {
  const transportKind = useEnvironment();

  // Picker mode: websocket transport + no crispy-cwd meta tag = root page.
  // Skip picker if ?sessionId= is present (openPanel bootstrap).
  const isPickerMode = transportKind === 'websocket' &&
    !document.querySelector('meta[name="crispy-cwd"]')?.getAttribute('content') &&
    !new URLSearchParams(window.location.search).get('sessionId');

  if (isPickerMode) return <WorkspacePicker />;

  const {
    toolPanelOpen, toolPanelWidthPx, fileViewerWidthPx, fileViewerOpen,
  } = useActiveTabPanel();
  const { selectedSessionId } = useSession();
  const { channelState } = useSessionStatus(selectedSessionId);
  const isStreaming = channelState === 'streaming';
  const layoutRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);

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

  // Determine file viewer overlay state:
  // - Container < 800px → overlay
  // - 800-1100px with sidebar open → file viewer overlays
  // - > 1100px → both get layout space
  const isFileViewerOverlay = fileViewerOpen && (
    containerWidth < OVERLAY_BREAKPOINT_PX ||
    (toolPanelOpen && containerWidth < DUAL_PANEL_BREAKPOINT_PX)
  );
  const fileViewerWidth = fileViewerOpen && !isFileViewerOverlay ? fileViewerPx : 0;

  // --right-panels-width = sum of both panels' layout-reserved widths
  const rightPanelsWidth = toolPanelWidth + fileViewerWidth;

  // File viewer panel state attribute
  const fileViewerState = fileViewerOpen
    ? (isFileViewerOverlay ? 'overlay' : 'open')
    : 'collapsed';

  return (
    <ActiveTabAgencyProvider>
      <div
        ref={layoutRef}
        className="crispy-layout"
        data-tool-panel={toolPanelOpen ? (isSidebarOverlay ? 'overlay' : 'open') : 'collapsed'}
        data-file-viewer={fileViewerState}
        style={{
          '--tool-panel-width': `${toolPanelWidth}px`,
          '--tool-panel-actual-width': `${toolPanelOpen ? panelPx : 0}px`,
          '--file-viewer-width': `${fileViewerOpen ? fileViewerPx : 0}px`,
          '--right-panels-width': `${rightPanelsWidth}px`,
          '--container-width': `${containerWidth}px`,
        } as React.CSSProperties}
      >
        <TitleBar />

        <AgencyMain isStreaming={isStreaming}>
            <FlexAppLayout />
        </AgencyMain>
      </div>
    </ActiveTabAgencyProvider>
  );
}

/**
 * AgencyMain — reads agencyMode from ControlPanelContext and sets
 * data-agency on .crispy-main directly, replacing the CSS :has() selectors.
 * Isolated in its own component so agencyMode changes only re-render this
 * thin wrapper, not the entire AppLayout.
 */
function AgencyMain({
  isStreaming,
  children,
}: {
  isStreaming: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { agencyMode } = useActiveTabAgency();
  return (
    <main
      className="crispy-main"
      data-streaming={isStreaming || undefined}
      data-agency={agencyMode}
    >
      {children}
    </main>
  );
}
