/**
 * TabSessionContext — per-tab session identity and CWD
 *
 * Wraps each TranscriptViewer instance to provide a tab-local session surface.
 * In single-tab mode, delegates to the global SessionContext. In multi-tab,
 * each tab has its own effectiveSessionId and derived CWD.
 *
 * Components inside a tab read `useTabSession()` instead of `useSession()`
 * for session identity. Components outside tabs (TitleBar, workspace picker)
 * continue reading the global SessionContext.
 *
 * @module TabSessionContext
 */

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from './SessionContext.js';
import { formatCwd, slugToPath } from '../hooks/useSessionCwd.js';
import type { CwdInfo } from '../hooks/useSessionCwd.js';

// ============================================================================
// Context Shape
// ============================================================================

interface TabSessionContextValue {
  /** The session ID this tab is displaying. */
  effectiveSessionId: string | null;
  /** Derived CWD info for this tab's session. */
  effectiveCwd: CwdInfo;
  /** Per-tab draft CWD slug (for new-session flows). */
  selectedCwd: string | null;
  /** Set the per-tab draft CWD. */
  setSelectedCwd: (slug: string | null) => void;
  /** Workspace CWD path for send routing. */
  workspaceCwdPath: string | null;
  /** Set the tab's session ID. */
  setSelectedSessionId: (id: string | null) => void;
}

const TabSessionCtx = createContext<TabSessionContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface TabSessionProviderProps {
  /** Explicit session ID for this tab. Falls back to global selectedSessionId. */
  sessionId?: string | null;
  /** Called when the tab's session changes (user selects a session within the tab). */
  onSessionChange?: (sessionId: string | null) => void;
  children: React.ReactNode;
}

/**
 * Provides per-tab session identity. In single-tab mode (no sessionId prop),
 * delegates entirely to the global SessionContext — zero behavioral change.
 */
export function TabSessionProvider({ sessionId: sessionIdProp, onSessionChange, children }: TabSessionProviderProps): React.JSX.Element {
  const global = useSession();

  // Internal state tracks the tab's session. Initialized from prop, updated
  // when user selects a session within the tab (via setSelectedSessionId).
  const [localSessionId, setLocalSessionId] = useState<string | null | undefined>(sessionIdProp);

  // Sync from prop when it changes externally (e.g., bootstrap assignment)
  useEffect(() => {
    setLocalSessionId(sessionIdProp);
  }, [sessionIdProp]);

  const effectiveSessionId = localSessionId !== undefined ? localSessionId : global.selectedSessionId;

  const effectiveCwd: CwdInfo = useMemo(() => {
    if (!effectiveSessionId) return { slug: null, fullPath: null, display: null };

    const session = global.sessions.find(s => s.sessionId === effectiveSessionId);
    const slug = session?.projectSlug ?? global.selectedCwd;
    if (!slug) return { slug: null, fullPath: null, display: null };

    const realPath = session?.projectPath ?? null;
    const fullPath = realPath ?? slugToPath(slug);
    return { slug, fullPath, display: formatCwd(fullPath) };
  }, [effectiveSessionId, global.sessions, global.selectedCwd]);

  // When onSessionChange is provided, route session selection through it
  // (FlexAppLayout uses this to update its tab→session map).
  // Fall back to global setter for single-tab / legacy mode.
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;

  const setSelectedSessionId = useCallback((id: string | null) => {
    setLocalSessionId(id); // Update local state so this tab re-renders immediately
    if (onSessionChangeRef.current) {
      onSessionChangeRef.current(id);
    } else {
      global.setSelectedSessionId(id);
    }
  }, [global.setSelectedSessionId]);

  const value: TabSessionContextValue = useMemo(() => ({
    effectiveSessionId,
    effectiveCwd,
    selectedCwd: global.selectedCwd,
    setSelectedCwd: global.setSelectedCwd,
    workspaceCwdPath: global.workspaceCwdPath,
    setSelectedSessionId,
  }), [
    effectiveSessionId,
    effectiveCwd,
    global.selectedCwd,
    global.setSelectedCwd,
    global.workspaceCwdPath,
    setSelectedSessionId,
  ]);

  return (
    <TabSessionCtx.Provider value={value}>
      {children}
    </TabSessionCtx.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Access tab-local session state. Falls back to global SessionContext
 * when used outside a TabSessionProvider (backwards compatibility).
 */
export function useTabSession(): TabSessionContextValue {
  const tabCtx = useContext(TabSessionCtx);
  if (tabCtx) return tabCtx;

  // Fallback: no TabSessionProvider in tree — construct from global context.
  // This keeps components that haven't been migrated yet working.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useTabSessionFallback();
}

/** Construct TabSessionContextValue from global SessionContext. */
function useTabSessionFallback(): TabSessionContextValue {
  const global = useSession();

  const effectiveCwd: CwdInfo = useMemo(() => {
    if (!global.selectedCwd) return { slug: null, fullPath: null, display: null };
    const realPath = global.sessions.find(
      s => s.projectSlug === global.selectedCwd && s.projectPath,
    )?.projectPath;
    const fullPath = realPath ?? slugToPath(global.selectedCwd);
    return { slug: global.selectedCwd, fullPath, display: formatCwd(fullPath) };
  }, [global.selectedCwd, global.sessions]);

  return useMemo(() => ({
    effectiveSessionId: global.selectedSessionId,
    effectiveCwd,
    selectedCwd: global.selectedCwd,
    setSelectedCwd: global.setSelectedCwd,
    workspaceCwdPath: global.workspaceCwdPath,
    setSelectedSessionId: global.setSelectedSessionId,
  }), [
    global.selectedSessionId,
    effectiveCwd,
    global.selectedCwd,
    global.setSelectedCwd,
    global.workspaceCwdPath,
    global.setSelectedSessionId,
  ]);
}
