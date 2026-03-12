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
import { EnvironmentProvider } from './context/EnvironmentContext.js';
import { SessionProvider, useSession } from './context/SessionContext.js';
import { FileIndexProvider } from './context/FileIndexContext.js';
import { PreferencesProvider, usePreferences } from './context/PreferencesContext.js';
import { FilePanelProvider } from './context/FilePanelContext.js';
import { TranscriptViewer } from './components/TranscriptViewer.js';
import { TitleBar } from './components/TitleBar.js';
import { SessionStatusProvider, useSessionStatus } from './hooks/useSessionStatus.js';
import { ContentErrorBoundary } from './components/ErrorBoundary.js';
import { isPerfMode, PerfOverlay, PerfProfiler } from './perf/index.js';
import { ControlPanelProvider, useControlPanel } from './context/ControlPanelContext.js';

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
            <FilePanelProvider>
            <PreferencesProvider>
              <SessionStatusProvider>
                <PerfProfiler id="App">
                  <AppLayout />
                </PerfProfiler>
                {isPerfMode && <PerfOverlay />}
              </SessionStatusProvider>
            </PreferencesProvider>
            </FilePanelProvider>
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

function AppLayout(): React.JSX.Element {
  const {
    toolPanelOpen, toolPanelWidthPx,
  } = usePreferences();
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

  // ---- Tool panel width ----
  const autoPx = Math.min(Math.max(Math.round(containerWidth * PANEL_RATIO), MIN_PANEL_PX), MAX_PANEL_PX);
  const panelPx = toolPanelWidthPx != null
    ? Math.min(Math.max(toolPanelWidthPx, MIN_PANEL_PX), MAX_PANEL_PX)
    : autoPx;
  const isOverlay = toolPanelOpen && containerWidth < OVERLAY_BREAKPOINT_PX;
  const toolPanelWidth = toolPanelOpen && !isOverlay ? panelPx : 0;

  return (
    <ControlPanelProvider selectedSessionId={selectedSessionId}>
      <div
        ref={layoutRef}
        className="crispy-layout"
        data-tool-panel={toolPanelOpen ? (isOverlay ? 'overlay' : 'open') : 'collapsed'}
        style={{
          '--tool-panel-width': `${toolPanelWidth}px`,
          '--tool-panel-actual-width': `${toolPanelOpen ? panelPx : 0}px`,
          '--right-panels-width': `${toolPanelWidth}px`,
          '--container-width': `${containerWidth}px`,
        } as React.CSSProperties}
      >
        <TitleBar />

        <AgencyMain isStreaming={isStreaming}>
          <ContentErrorBoundary>
            <TranscriptViewer />
          </ContentErrorBoundary>
        </AgencyMain>
      </div>
    </ControlPanelProvider>
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
  const { agencyMode } = useControlPanel();
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
