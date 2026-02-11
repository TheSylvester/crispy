/**
 * App — Root component, layout shell with context providers
 *
 * Wraps the app in TransportProvider and SessionProvider, then renders
 * the two-column layout: sidebar (SessionSelector) + main (TranscriptViewer).
 * AppLayout lives inside providers so it can use context hooks for sidebar state.
 *
 * @module App
 */

import { useState } from 'react';
import type { Transport } from './transport.js';
import { TransportProvider } from './context/TransportContext.js';
import { SessionProvider, useSession } from './context/SessionContext.js';
import { PreferencesProvider, usePreferences } from './context/PreferencesContext.js';
import { SessionSelector } from './components/SessionSelector.js';
import { TranscriptViewer } from './components/TranscriptViewer.js';
import { useSessionStatus } from './hooks/useSessionStatus.js';

interface AppProps {
  transport: Transport;
}

export function App({ transport }: AppProps): React.JSX.Element {
  return (
    <TransportProvider transport={transport}>
      <SessionProvider>
        <PreferencesProvider>
          <AppLayout />
        </PreferencesProvider>
      </SessionProvider>
    </TransportProvider>
  );
}

function AppLayout(): React.JSX.Element {
  const { sidebarCollapsed, setSidebarCollapsed } = usePreferences();
  const { selectedSessionId } = useSession();
  const { channelState } = useSessionStatus(selectedSessionId);
  const isStreaming = channelState === 'streaming';
  const [sidebarOverlay, setSidebarOverlay] = useState(false);

  const sidebarClasses = [
    'crispy-sidebar',
    sidebarOverlay ? 'crispy-sidebar--overlay' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className="crispy-layout"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'docked'}
    >
      {/* Hover zone — only active when collapsed */}
      <div
        className="crispy-sidebar-hover-zone"
        onMouseEnter={() => setSidebarOverlay(true)}
      />

      <aside
        className={sidebarClasses}
        onMouseLeave={() => {
          if (sidebarCollapsed) setSidebarOverlay(false);
        }}
      >
        <div className="crispy-sidebar__header">Sessions</div>
        <SessionSelector />
      </aside>

      {/* Toggle tab */}
      <button
        className="crispy-sidebar-toggle"
        onClick={() => {
          setSidebarCollapsed(!sidebarCollapsed);
          setSidebarOverlay(false);
        }}
        aria-label={sidebarCollapsed ? 'Show sessions' : 'Hide sessions'}
      >
        {sidebarCollapsed ? '\u25B6' : '\u25C0'}
      </button>

      <main className="crispy-main" data-streaming={isStreaming || undefined}>
        <TranscriptViewer />
      </main>
    </div>
  );
}
