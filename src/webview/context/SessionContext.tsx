/**
 * Session Context — session list + selection state
 *
 * Loads sessions on mount via transport.listSessions() and exposes
 * the list + selection to child components.
 *
 * @module SessionContext
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { WireSessionInfo } from '../transport.js';
import { useTransport } from './TransportContext.js';

interface SessionState {
  sessions: WireSessionInfo[];
  selectedSessionId: string | null;
  isLoading: boolean;
  error: string | null;
}

interface SessionContextValue extends SessionState {
  setSelectedSessionId: (id: string | null) => void;
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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const value: SessionContextValue = {
    sessions,
    selectedSessionId,
    isLoading,
    error,
    setSelectedSessionId,
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
