/**
 * Sidebar Webview Entry — Open Sessions sidebar mount
 *
 * Renders `SessionsPanel` in VS Code's Activity Bar. Clicks fire a
 * `revealSession` postMessage that the host routes through `openPanel`,
 * which reveals the native VS Code editor panel for that session (or creates
 * a new one). FlexLayout is not involved.
 *
 * Data flow: a hand-rolled `sidebar-transport` (see ./sidebar-transport.ts)
 * supplies `listOpenSessions` + a session-list change stream. We provide
 * stub `<TransportProvider>` and `<SessionContext.Provider>` values so the
 * unmodified `SessionsPanel` component can run here without dragging in the
 * full `transport-vscode` + `SessionProvider` machinery (which would
 * roughly double the sidebar bundle for unused functionality).
 *
 * @module sidebar-entry
 */

import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionsPanel } from './components/sessions-panel/SessionsPanel.js';
import { TransportProvider } from './context/TransportContext.js';
import { SessionContext, type SessionContextValue } from './context/SessionContext.js';
import type { SessionService, WireSessionInfo } from './transport.js';
import type { SessionChannelState } from '../core/session-channel.js';
import { createSidebarTransport, type SidebarTransport } from './sidebar-transport.js';

const sidebarTransport: SidebarTransport = createSidebarTransport();

// SessionsPanel only calls `listOpenSessions`; cast through `unknown` to
// satisfy the consumed slice without implementing the rest.
const transportStub = {
  listOpenSessions: () => sidebarTransport.listOpenSessions(),
} as unknown as SessionService;

function SidebarApp(): React.JSX.Element {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    return sidebarTransport.onSessionListChange(() => setTick((n) => n + 1));
  }, []);

  // SessionsPanel re-runs its fetch effect when `sessions`/`sessionStatuses`
  // change identity. Reseat both per host ping to retrigger the fetch.
  const sessionState = useMemo<SessionContextValue>(() => {
    const sessions: WireSessionInfo[] = [];
    const sessionStatuses = new Map<string, SessionChannelState>();
    const noop = (): void => {};
    const reject = async (): Promise<never> => {
      throw new Error('Operation not available in the Open Sessions sidebar');
    };
    return {
      sessions,
      selectedSessionId: null,
      selectedCwd: null,
      isLoading: false,
      error: null,
      setSelectedSessionId: noop,
      setSelectedCwd: noop,
      refreshSessions: noop,
      findSession: reject as SessionContextValue['findSession'],
      availableVendors: [],
      workspaceCwdPath: null,
      sessionStatuses,
      isAutoClosePanel: false,
    };
  }, [tick]);

  return (
    <TransportProvider transport={transportStub}>
      <SessionContext.Provider value={sessionState}>
        <SessionsPanel
          mode="sidebar"
          onActivate={(sessionId) => sidebarTransport.revealSession(sessionId)}
        />
      </SessionContext.Provider>
    </TransportProvider>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<SidebarApp />);
}
