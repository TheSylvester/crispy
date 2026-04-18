/**
 * App — Root component, layout shell with context providers
 *
 * Wraps the app in TransportProvider and SessionProvider, then renders
 * the two-column layout: TitleBar (global chrome) + FlexAppLayout (tabs).
 * Each tab owns its own provider cascade for panels, sessions, and controls.
 *
 * @module App
 */

import type { Transport } from './transport.js';
import type { TransportKind } from './main.js';
import { TransportProvider } from './context/TransportContext.js';
import { EnvironmentProvider, useEnvironment } from './context/EnvironmentContext.js';
import { SessionProvider, useSession } from './context/SessionContext.js';
import { TabControllerProvider } from './context/TabControllerContext.js';
import { PreferencesProvider } from './context/PreferencesContext.js';
import { FlexAppLayout } from './components/FlexAppLayout.js';
import { TitleBar } from './components/TitleBar.js';
import { isPerfMode, PerfOverlay, PerfProfiler } from './perf/index.js';
import { TrackerToast } from './components/notifications/TrackerToast.js';
import { WorkspacePicker } from './components/WorkspacePicker.js';
import { OsDropOverlay } from './components/file-panel/OsDropOverlay.js';

interface AppProps {
  transport: Transport;
  transportKind: TransportKind;
}

export function App({ transport, transportKind }: AppProps): React.JSX.Element {
  return (
    <TransportProvider transport={transport}>
      <EnvironmentProvider kind={transportKind}>
        <SessionProvider>
          <TabControllerBridge>
            <PreferencesProvider>
              <PerfProfiler id="App">
                <AppLayout />
              </PerfProfiler>
              {isPerfMode && <PerfOverlay />}
              <TrackerToast />
              <OsDropOverlay />
            </PreferencesProvider>
          </TabControllerBridge>
        </SessionProvider>
      </EnvironmentProvider>
    </TransportProvider>
  );
}

/** Thin bridge: wires TabControllerProvider's onSessionChange to SessionContext's setter. */
function TabControllerBridge({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { setSelectedSessionId } = useSession();
  return (
    <TabControllerProvider onSessionChange={setSelectedSessionId}>
      {children}
    </TabControllerProvider>
  );
}

function AppLayout(): React.JSX.Element {
  const transportKind = useEnvironment();

  // Picker mode: browser-based transport + no crispy-cwd meta tag = root page.
  // Skip picker if ?sessionId= is present (openPanel bootstrap).
  const isPickerMode = (transportKind === 'websocket' || transportKind === 'tauri') &&
    !document.querySelector('meta[name="crispy-cwd"]')?.getAttribute('content') &&
    !new URLSearchParams(window.location.search).get('sessionId');

  if (isPickerMode) return <WorkspacePicker />;

  return (
    <div className="crispy-layout">
      <TitleBar />
      <main className="crispy-main">
        <FlexAppLayout />
      </main>
    </div>
  );
}
