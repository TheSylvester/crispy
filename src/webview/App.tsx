/**
 * App — Root component, layout shell with context providers
 *
 * Wraps the app in TransportProvider and SessionProvider, then renders
 * the two-column layout: sidebar (SessionSelector) + main (TranscriptViewer).
 *
 * @module App
 */

import type { Transport } from './transport.js';
import { TransportProvider } from './context/TransportContext.js';
import { SessionProvider } from './context/SessionContext.js';
import { PreferencesProvider } from './context/PreferencesContext.js';
import { SessionSelector } from './components/SessionSelector.js';
import { TranscriptViewer } from './components/TranscriptViewer.js';

interface AppProps {
  transport: Transport;
}

export function App({ transport }: AppProps): React.JSX.Element {
  return (
    <TransportProvider transport={transport}>
      <SessionProvider>
        <PreferencesProvider>
          <div className="crispy-layout">
            <aside className="crispy-sidebar">
              <div className="crispy-sidebar__header">Sessions</div>
              <SessionSelector />
            </aside>
            <main className="crispy-main">
              <TranscriptViewer />
            </main>
          </div>
        </PreferencesProvider>
      </SessionProvider>
    </TransportProvider>
  );
}
