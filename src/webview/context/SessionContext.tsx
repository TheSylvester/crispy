/**
 * Session Context — session list + CWD state
 *
 * Loads sessions on mount via transport.listSessions() and exposes
 * the list and CWD to child components.
 *
 * CWD tracks the selected working directory as a projectSlug (canonical key).
 * It is workspace-scoped, not per-tab. Tabs update CWD via setSelectedCwd
 * when their session changes and they are the active tab.
 *
 * Session selection is fully per-tab — each FlexLayout transcript tab owns
 * its session ID via internal component state. There is no global
 * selectedSessionId.
 *
 * @module SessionContext
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { WireSessionInfo } from '../transport.js';
import { useTransport } from './TransportContext.js';
import { SESSION_LIST_CHANNEL_ID } from '../../core/session-list-events.js';
import { pathToSlug } from '../hooks/useSessionCwd.js';

interface SessionState {
  sessions: WireSessionInfo[];
  selectedCwd: string | null;
  isLoading: boolean;
  error: string | null;
}

interface SessionContextValue extends SessionState {
  setSelectedCwd: (slug: string | null) => void;
  refreshSessions: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  children: React.ReactNode;
}

export function SessionProvider({ children }: SessionProviderProps): React.JSX.Element {
  const transport = useTransport();
  const [sessions, setSessions] = useState<WireSessionInfo[]>([]);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track whether initial CWD default has been applied
  const cwdInitialized = useRef(false);

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

  // Listen for workspace CWD hint from VS Code host (sent via postMessage).
  // If it arrives before sessions load, apply it immediately as the default.
  const workspaceCwdRef = useRef<string | null>(null);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.data?.kind === 'workspaceCwd' && ev.data.cwd) {
        workspaceCwdRef.current = pathToSlug(ev.data.cwd);
        // If CWD hasn't been initialized yet via sessions, apply immediately
        if (!cwdInitialized.current) {
          setSelectedCwd(workspaceCwdRef.current);
        }
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Default CWD: prefer workspace hint, fall back to MRU session slug.
  // Handles both orderings — workspace message first or sessions first.
  useEffect(() => {
    if (cwdInitialized.current || sessions.length === 0) return;
    cwdInitialized.current = true;

    if (workspaceCwdRef.current) {
      setSelectedCwd(workspaceCwdRef.current);
    } else {
      // Sessions are sorted by modifiedAt desc — first session has the most recent project
      const firstSlug = sessions[0]?.projectSlug;
      if (firstSlug && !selectedCwd) {
        setSelectedCwd(firstSlug);
      }
    }
  }, [sessions, selectedCwd]);

  const value: SessionContextValue = {
    sessions,
    selectedCwd,
    isLoading,
    error,
    setSelectedCwd,
    refreshSessions: loadSessions,
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
