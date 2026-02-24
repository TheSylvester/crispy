/**
 * App — Root component with context provider cascade
 *
 * Wraps the app in TransportProvider → SessionProvider → etc, then renders
 * FlexAppLayout which owns the full layout (sidebar, FlexLayout docking,
 * control panel, overlays). The old AppLayout (position:fixed panels) has
 * been replaced.
 *
 * @module App
 */

import type { Transport } from './transport.js';
import type { TransportKind } from './main.js';
import { TransportProvider } from './context/TransportContext.js';
import { EnvironmentProvider } from './context/EnvironmentContext.js';
import { SessionProvider } from './context/SessionContext.js';
import { FileIndexProvider } from './context/FileIndexContext.js';
import { PreferencesProvider } from './context/PreferencesContext.js';
import { isPerfMode, PerfOverlay, PerfProfiler } from './perf/index.js';
import { FlexAppLayout } from './FlexAppLayout.js';

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
                <PerfProfiler id="App">
                  <FlexAppLayout />
                </PerfProfiler>
                {isPerfMode && <PerfOverlay />}
            </PreferencesProvider>
          </FileIndexProvider>
        </SessionProvider>
      </EnvironmentProvider>
    </TransportProvider>
  );
}

// AppLayout (position:fixed panel system) removed — replaced by FlexAppLayout.
// See git history for the original implementation.
