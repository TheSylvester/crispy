/**
 * Session Context — session list + selection + CWD state
 *
 * Loads sessions on mount via transport.listSessions() and exposes
 * the list, selection, and CWD to child components.
 *
 * CWD tracks the selected working directory as a projectSlug (canonical key).
 * Auto-syncs when a session is selected; independent manual changes don't
 * alter the selected session (supports "new conversation" prep flow).
 *
 * @module SessionContext
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { WireSessionInfo } from '../transport.js';
import { useTransport } from './TransportContext.js';
import { useEnvironment } from './EnvironmentContext.js';
import { SESSION_LIST_CHANNEL_ID } from '../../core/session-list-events.js';
import { pathToSlug } from '../hooks/useSessionCwd.js';

interface SessionState {
  sessions: WireSessionInfo[];
  selectedSessionId: string | null;
  selectedCwd: string | null;
  isLoading: boolean;
  error: string | null;
}

interface SessionContextValue extends SessionState {
  setSelectedSessionId: (id: string | null) => void;
  setSelectedCwd: (slug: string | null) => void;
  refreshSessions: () => void;
  availableVendors: string[];
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  children: React.ReactNode;
}

export function SessionProvider({ children }: SessionProviderProps): React.JSX.Element {
  const transport = useTransport();
  const transportKind = useEnvironment();
  const [sessions, setSessions] = useState<WireSessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Manual refresh fallback — kept in context value for explicit "pull" scenarios
  const loadSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await transport.listSessions();
      setSessions(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [transport]);

  // Combined load + subscribe effect: subscribe first (so we don't miss
  // upserts during load), then load the initial snapshot, then listen for
  // push upserts on the sentinel sessionId.
  useEffect(() => {
    let unmounted = false;

    // 1. Subscribe first
    transport.subscribeSessionList().catch(() => {});

    // 2. Load initial snapshot
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await transport.listSessions();
        if (!unmounted) setSessions(result);
      } catch (err) {
        if (!unmounted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!unmounted) setIsLoading(false);
      }
    })();

    // 3. Listen for upserts on the sentinel sessionId
    const off = transport.onEvent((sessionId, event) => {
      if (unmounted || sessionId !== SESSION_LIST_CHANNEL_ID) return;
      if (event.type === 'session_list_upsert') {
        // JSON serialization converts Date→string, so it arrives as WireSessionInfo
        const upserted = event.session as unknown as WireSessionInfo;
        setSessions((prev) => {
          const filtered = prev.filter((s) => s.sessionId !== upserted.sessionId);
          const next = [upserted, ...filtered];
          next.sort((a, b) =>
            new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
          );
          return next;
        });
      }
    });

    return () => {
      unmounted = true;
      off();
      transport.unsubscribeSessionList().catch(() => {});
    };
  }, [transport]);

  // Auto-sync: when selectedSessionId changes, update CWD to that session's slug
  useEffect(() => {
    if (!selectedSessionId) return;
    const session = sessions.find((s) => s.sessionId === selectedSessionId);
    if (session?.projectSlug) {
      setSelectedCwd(session.projectSlug);
    }
  }, [selectedSessionId, sessions]);

  // Listen for workspace CWD hint from VS Code host (sent via postMessage).
  // In VS Code, auto-select the workspace project on initial load so the
  // sidebar scopes to the open workspace. In dev-server mode, default to
  // "All Projects" (selectedCwd = null).
  const workspaceCwdRef = useRef<string | null>(null);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.data?.kind === 'workspaceCwd' && ev.data.cwd) {
        const slug = pathToSlug(ev.data.cwd);
        workspaceCwdRef.current = slug;
        // In VS Code, auto-scope to workspace project if nothing selected yet
        if (transportKind === 'vscode') {
          setSelectedCwd((prev) => prev ?? slug);
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [transportKind]);

  // When a pending session gets its real ID, update selection
  useEffect(() => {
    if (!selectedSessionId?.startsWith('pending:')) return;
    const off = transport.onEvent((sessionId, event) => {
      if (
        sessionId === selectedSessionId &&
        event.type === 'event' &&
        event.event.type === 'notification' &&
        event.event.kind === 'session_changed'
      ) {
        setSelectedSessionId(event.event.sessionId);
      }
    });
    return off;
  }, [selectedSessionId, transport]);

  // Derive available vendors from sessions — native vendors first in stable order,
  // then dynamic vendors alphabetically.
  const availableVendors = useMemo(() => {
    const vendorSet = new Set<string>();
    for (const s of sessions) {
      if (s.vendor) vendorSet.add(s.vendor);
    }
    const native: string[] = [];
    const dynamic: string[] = [];
    for (const v of vendorSet) {
      if (v === 'claude' || v === 'codex' || v === 'gemini') native.push(v);
      else dynamic.push(v);
    }
    native.sort((a, b) => {
      const order = ['claude', 'codex', 'gemini'];
      return order.indexOf(a) - order.indexOf(b);
    });
    dynamic.sort();
    return [...native, ...dynamic];
  }, [sessions]);

  const value: SessionContextValue = {
    sessions,
    selectedSessionId,
    selectedCwd,
    isLoading,
    error,
    setSelectedSessionId,
    setSelectedCwd,
    refreshSessions: loadSessions,
    availableVendors,
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
}

/**
 * Access session state. Throws if used outside SessionProvider.
 */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
