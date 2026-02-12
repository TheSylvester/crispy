/**
 * App — Root component, layout shell with context providers
 *
 * Wraps the app in TransportProvider and SessionProvider, then renders
 * the two-column layout: sidebar (SessionSelector) + main (TranscriptViewer).
 * AppLayout lives inside providers so it can use context hooks for sidebar state.
 *
 * @module App
 */

import { useCallback } from 'react';
import type { Transport } from './transport.js';
import type { TransportKind } from './main.js';
import { TransportProvider } from './context/TransportContext.js';
import { SessionProvider, useSession } from './context/SessionContext.js';
import { PreferencesProvider, usePreferences } from './context/PreferencesContext.js';
import { SessionSelector } from './components/SessionSelector.js';
import { TranscriptViewer } from './components/TranscriptViewer.js';
import { TitleBar } from './components/TitleBar.js';
import { useSessionStatus } from './hooks/useSessionStatus.js';

interface AppProps {
  transport: Transport;
  transportKind: TransportKind;
}

export function App({ transport, transportKind }: AppProps): React.JSX.Element {
  return (
    <TransportProvider transport={transport}>
      <SessionProvider>
        <PreferencesProvider>
          <AppLayout transportKind={transportKind} />
        </PreferencesProvider>
      </SessionProvider>
    </TransportProvider>
  );
}

function AppLayout({ transportKind: _transportKind }: { transportKind: TransportKind }): React.JSX.Element {
  const { sidebarCollapsed, setSidebarCollapsed } = usePreferences();
  const { selectedSessionId } = useSession();
  const { channelState } = useSessionStatus(selectedSessionId);
  const isStreaming = channelState === 'streaming';

  const closeSidebar = useCallback(() => {
    setSidebarCollapsed(true);
  }, [setSidebarCollapsed]);

  return (
    <div
      className="crispy-layout"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'open'}
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
