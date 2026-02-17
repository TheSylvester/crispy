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

/** Chat content max-width (matches .crispy-transcript-content) + padding */
const CHAT_CONTENT_PX = 72 * 16 + 32; // 72rem + 32px transcript padding
/** Min panel width in px — below this the panel content is unusable */
const MIN_PANEL_PX = 350;
/** Max panel width in px — 60rem */
const MAX_PANEL_PX = 60 * 16; // 960px

function AppLayout(): React.JSX.Element {
  const { sidebarCollapsed, setSidebarCollapsed, toolPanelOpen, toolPanelWidthPx } = usePreferences();
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

  // Tool panel claims leftover space beyond what the chat content needs,
  // clamped between MIN and MAX. User drag override (toolPanelWidthPx) wins
  // when set; otherwise auto-compute from spare space.
  const spareSpace = containerWidth - CHAT_CONTENT_PX;
  const autoPx = Math.min(Math.max(spareSpace, MIN_PANEL_PX), MAX_PANEL_PX);
  const panelPx = toolPanelWidthPx != null
    ? Math.min(Math.max(toolPanelWidthPx, MIN_PANEL_PX), MAX_PANEL_PX)
    : autoPx;
  const toolPanelWidth = toolPanelOpen ? panelPx : 0;

  return (
    <div
      ref={layoutRef}
      className="crispy-layout"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'open'}
      data-tool-panel={toolPanelOpen ? 'open' : 'collapsed'}
      style={{
        '--tool-panel-width': `${toolPanelWidth}px`,
        '--container-width': `${containerWidth}px`,
      } as React.CSSProperties}
    >
      <TitleBar />

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
    </div>
  );
}
