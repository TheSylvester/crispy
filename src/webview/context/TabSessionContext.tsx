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
import { useEnvironment } from './EnvironmentContext.js';

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
  const envKind = useEnvironment();

  // Internal state tracks the tab's session. Initialized from prop, updated
  // when user selects a session within the tab (via setSelectedSessionId).
  const [localSessionId, setLocalSessionId] = useState<string | null | undefined>(sessionIdProp);

  // Per-tab CWD slug. `undefined` = inherit from global (unset),
  // `null` = explicitly "All Projects", `string` = explicit project.
  const [localCwd, setLocalCwd] = useState<string | null | undefined>(
    () => global.selectedCwd ?? undefined,
  );

  // Sync from prop when it changes externally (e.g., bootstrap assignment)
  useEffect(() => {
    setLocalSessionId(sessionIdProp);
  }, [sessionIdProp]);

  // In VS Code, sync workspace CWD to tab CWD on first arrival (one-shot).
  const cwdInitRef = useRef(false);
  useEffect(() => {
    if (cwdInitRef.current) return;
    if (envKind === 'vscode' && global.selectedCwd && localCwd === undefined) {
      setLocalCwd(global.selectedCwd);
      cwdInitRef.current = true;
    }
  }, [envKind, global.selectedCwd, localCwd]);

  const effectiveSessionId = localSessionId !== undefined ? localSessionId : global.selectedSessionId;

  // Derive CWD from the tab's session, then tab-local CWD, then global.
  // `localCwd === undefined` means "inherit from global".
  // `localCwd === null` means "All Projects" (explicitly cleared).
  const effectiveCwd: CwdInfo = useMemo(() => {
    const session = effectiveSessionId
      ? global.sessions.find(s => s.sessionId === effectiveSessionId)
      : null;
    const resolvedCwd = localCwd !== undefined ? localCwd : global.selectedCwd;
    const slug = session?.projectSlug ?? resolvedCwd;
    if (!slug) return { slug: null, fullPath: null, display: null };

    const realPath = session?.projectPath ?? null;
    const fullPath = realPath ?? slugToPath(slug);
    return { slug, fullPath, display: formatCwd(fullPath) };
  }, [effectiveSessionId, global.sessions, localCwd, global.selectedCwd]);

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

  // Per-tab CWD setter — updates local state, not global.
  const setSelectedCwd = useCallback((slug: string | null) => {
    setLocalCwd(slug);
  }, []);

  const value: TabSessionContextValue = useMemo(() => ({
    effectiveSessionId,
    effectiveCwd,
    selectedCwd: localCwd !== undefined ? localCwd : global.selectedCwd,
    setSelectedCwd,
    workspaceCwdPath: global.workspaceCwdPath,
    setSelectedSessionId,
  }), [
    effectiveSessionId,
    effectiveCwd,
    localCwd,
    global.selectedCwd,
    setSelectedCwd,
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
  const fallback = useTabSessionFallback();
  return tabCtx ?? fallback;
}

/**
 * Access tab-local session state if inside a TabSessionProvider, or null.
 * Used by hooks that need tab-local CWD without falling back to global.
 */
export function useTabSessionOptional(): TabSessionContextValue | null {
  return useContext(TabSessionCtx);
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
