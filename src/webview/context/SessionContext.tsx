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

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { WireSessionInfo } from '../transport.js';
import { useTransport } from './TransportContext.js';
import { SESSION_LIST_CHANNEL_ID } from '../../core/session-list-events.js';

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
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  children: React.ReactNode;
}

export function SessionProvider({ children }: SessionProviderProps): React.JSX.Element {
  const transport = useTransport();
  const [sessions, setSessions] = useState<WireSessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
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

  // Auto-sync: when selectedSessionId changes, update CWD to that session's slug
  useEffect(() => {
    if (!selectedSessionId) return;
    const session = sessions.find((s) => s.sessionId === selectedSessionId);
    if (session?.projectSlug) {
      setSelectedCwd(session.projectSlug);
    }
  }, [selectedSessionId, sessions]);

  // Default CWD: on initial session load, default to the most-recently-used project slug
  useEffect(() => {
    if (cwdInitialized.current || sessions.length === 0) return;
    cwdInitialized.current = true;
    // Sessions are sorted by modifiedAt desc — first session has the most recent project
    const firstSlug = sessions[0]?.projectSlug;
    if (firstSlug && !selectedCwd) {
      setSelectedCwd(firstSlug);
    }
  }, [sessions, selectedCwd]);

  // When a pending session gets its real ID, update selection
  useEffect(() => {
    if (!selectedSessionId?.startsWith('pending:')) return;
    const off = transport.onEvent((sessionId, event) => {
      if (
        sessionId === selectedSessionId &&
        event.type === 'notification' &&
        event.event.kind === 'session_changed'
      ) {
        setSelectedSessionId(event.event.sessionId);
      }
    });
    return off;
  }, [selectedSessionId, transport]);

  const value: SessionContextValue = {
    sessions,
    selectedSessionId,
    selectedCwd,
    isLoading,
    error,
    setSelectedSessionId,
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
