/**
 * TabControllerContext — cross-component tab routing surface
 *
 * Sits ABOVE both TitleBar and FlexAppLayout in the component tree.
 * FlexAppLayout registers tab operations on mount; TitleBar, SessionSelector,
 * and SessionContext call controller methods instead of directly mutating
 * global selectedSessionId.
 *
 * Pre-registration queue: if navigateToSession/createTab is called before
 * FlexAppLayout registers (e.g. during VS Code openPanel bootstrap),
 * the request is buffered and replayed on registration.
 *
 * @module context/TabControllerContext
 */

import { createContext, useContext, useCallback, useRef, useMemo, useState } from 'react';

// ============================================================================
// Types
// ============================================================================

export interface ForkConfig {
  fromSessionId: string;
  atMessageId?: string;
  initialPrompt?: string;
  model?: string;
  agencyMode?: string;
  bypassEnabled?: boolean;
  chromeEnabled?: boolean;
}

export interface TabCreateConfig {
  forkConfig?: ForkConfig;
  sessionId?: string;
  /** Target tabset ID for the new tab (defaults to main tabset). */
  tabsetId?: string;
  /** Tab component type (defaults to 'transcript'). */
  component?: string;
  /** Tab display name (defaults to session name or 'New Tab'). */
  name?: string;
  /** Arbitrary config passed to the FlexLayout node (accessible via node.getConfig()). */
  config?: Record<string, unknown>;
}

interface TabOperations {
  createTab: (config?: TabCreateConfig) => string;
  closeTab: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  /** Find tab displaying this session, or null. */
  findTabBySession: (sessionId: string) => string | null;
  /** Get session ID for a tab, or null. */
  getTabSession: (tabId: string) => string | null;
  /** Find first tab with the given component type, or null. */
  findTabByComponent: (component: string) => string | null;
  /** Toggle the Git border panel open/closed. */
  toggleGitBorder: () => void;
  /** Toggle the Files border panel open/closed. */
  toggleFilesBorder: () => void;
  /** Find a file-viewer tab by path, or null. */
  findFileViewerTab: (path: string) => string | null;
  /** Update a tab's config. */
  updateTabConfig: (tabId: string, config: Record<string, unknown>) => void;
  /** Equalize weights of all tabsets in the root row. */
  equalizeLayout: () => void;
  /** Toggle the Terminal border panel open/closed. */
  toggleTerminalBorder: () => void;
}

export interface TabControllerValue {
  /** Create a new tab, optionally with fork config or session ID. Returns tab ID. */
  createTab: (config?: TabCreateConfig) => string;
  /** Close a tab by ID. */
  closeTab: (tabId: string) => void;
  /** Activate (switch to) a tab by ID. */
  activateTab: (tabId: string) => void;

  /** Navigate to a session: find existing tab or create new, then activate. */
  navigateToSession: (sessionId: string, name?: string) => void;
  /** Set the active tab's session ID (used by session selector within a tab). */
  setActiveTabSession: (sessionId: string | null) => void;

  /** Find first tab with the given component type, or null. */
  findTabByComponent: (component: string) => string | null;
  /** Toggle the Git border panel open/closed. */
  toggleGitBorder: () => void;
  /** Toggle the Files border panel open/closed. */
  toggleFilesBorder: () => void;
  /** Find a file-viewer tab by path, or null. */
  findFileViewerTab: (path: string) => string | null;
  /** Update a tab's config (e.g. to change line number for file-viewer). */
  updateTabConfig: (tabId: string, config: Record<string, unknown>) => void;
  /** Equalize weights of all tabsets in the root row. */
  equalizeLayout: () => void;
  /** Toggle the Terminal border panel open/closed. */
  toggleTerminalBorder: () => void;

  /** Currently active FlexLayout tab ID. */
  activeTabId: string | null;
  /** Session ID of the currently active tab. */
  activeTabSessionId: string | null;
  /** Last transcript tab that was active (not reset by border tab selection). */
  lastActiveTranscriptTabId: string | null;

  /** Register FlexLayout tab operations (called once on mount). */
  registerOperations: (ops: TabOperations) => void;
  /** Update active tab info (called by FlexAppLayout on tab change). */
  setActiveTab: (tabId: string | null, sessionId: string | null, isTranscriptTab?: boolean) => void;
}

// ============================================================================
// Context
// ============================================================================

const TabControllerCtx = createContext<TabControllerValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface TabControllerProviderProps {
  /** Callback to update global selectedSessionId when active tab changes. */
  onSessionChange: (sessionId: string | null) => void;
  children: React.ReactNode;
}

export function TabControllerProvider({ onSessionChange, children }: TabControllerProviderProps): React.JSX.Element {
  const opsRef = useRef<TabOperations | null>(null);
  const pendingOps = useRef<Array<() => void>>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activeTabSessionId, setActiveTabSessionId] = useState<string | null>(null);
  const [lastActiveTranscriptTabId, setLastActiveTranscriptTabId] = useState<string | null>(null);

  // Stable ref for onSessionChange to avoid re-renders
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;

  const registerOperations = useCallback((ops: TabOperations) => {
    opsRef.current = ops;
    // Flush pending operations
    const pending = pendingOps.current;
    pendingOps.current = [];
    for (const op of pending) op();
  }, []);

  const setActiveTab = useCallback((tabId: string | null, sessionId: string | null, isTranscriptTab?: boolean) => {
    setActiveTabId(tabId);
    setActiveTabSessionId(sessionId);
    if (sessionId !== null) {
      // Transcript tab with session — update last active and propagate session
      setLastActiveTranscriptTabId(tabId);
      onSessionChangeRef.current(sessionId);
    } else if (isTranscriptTab) {
      // Transcript tab without session (new tab) — still track as last active
      // so file-viewer tabs can insert into its chat input
      setLastActiveTranscriptTabId(tabId);
    }
    // Non-transcript tab (file-viewer, git, etc.) — don't update lastActiveTranscriptTabId
  }, []);

  const createTab = useCallback((config?: TabCreateConfig): string => {
    if (!opsRef.current) {
      // Buffer — return a placeholder ID, the real one comes on flush
      const placeholder = `pending-tab-${Date.now()}`;
      pendingOps.current.push(() => opsRef.current!.createTab(config));
      return placeholder;
    }
    return opsRef.current.createTab(config);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    if (!opsRef.current) {
      pendingOps.current.push(() => opsRef.current!.closeTab(tabId));
      return;
    }
    opsRef.current.closeTab(tabId);
  }, []);

  const activateTab = useCallback((tabId: string) => {
    if (!opsRef.current) {
      pendingOps.current.push(() => opsRef.current!.activateTab(tabId));
      return;
    }
    opsRef.current.activateTab(tabId);
  }, []);

  const findTabByComponent = useCallback((component: string): string | null => {
    if (!opsRef.current) return null;
    return opsRef.current.findTabByComponent(component);
  }, []);

  const toggleGitBorder = useCallback(() => {
    if (!opsRef.current) return;
    opsRef.current.toggleGitBorder();
  }, []);

  const toggleFilesBorder = useCallback(() => {
    if (!opsRef.current) return;
    opsRef.current.toggleFilesBorder();
  }, []);

  const findFileViewerTab = useCallback((path: string): string | null => {
    if (!opsRef.current) return null;
    return opsRef.current.findFileViewerTab(path);
  }, []);

  const updateTabConfig = useCallback((tabId: string, config: Record<string, unknown>) => {
    if (!opsRef.current) return;
    opsRef.current.updateTabConfig(tabId, config);
  }, []);

  const equalizeLayout = useCallback(() => {
    if (!opsRef.current) return;
    opsRef.current.equalizeLayout();
  }, []);

  const toggleTerminalBorder = useCallback(() => {
    if (!opsRef.current) return;
    opsRef.current.toggleTerminalBorder();
  }, []);

  const navigateToSession = useCallback((sessionId: string, name?: string) => {
    if (!opsRef.current) {
      pendingOps.current.push(() => {
        const ops = opsRef.current!;
        const existing = ops.findTabBySession(sessionId);
        if (existing) {
          ops.activateTab(existing);
        } else {
          ops.createTab({ sessionId, name });
        }
      });
      return;
    }
    const existing = opsRef.current.findTabBySession(sessionId);
    if (existing) {
      opsRef.current.activateTab(existing);
    } else {
      opsRef.current.createTab({ sessionId, name });
    }
  }, []);

  const setActiveTabSession = useCallback((sessionId: string | null) => {
    // This is called when a user selects a session within the active tab.
    // FlexAppLayout handles updating its internal tab→session map.
    // We just update the global state.
    setActiveTabSessionId(sessionId);
    onSessionChangeRef.current(sessionId);
  }, []);

  const value: TabControllerValue = useMemo(() => ({
    createTab,
    closeTab,
    activateTab,
    findTabByComponent,
    toggleGitBorder,
    toggleFilesBorder,
    findFileViewerTab,
    updateTabConfig,
    equalizeLayout,
    toggleTerminalBorder,
    navigateToSession,
    setActiveTabSession,
    activeTabId,
    activeTabSessionId,
    lastActiveTranscriptTabId,
    registerOperations,
    setActiveTab,
  }), [
    createTab, closeTab, activateTab, findTabByComponent, toggleGitBorder,
    toggleFilesBorder, findFileViewerTab, updateTabConfig, equalizeLayout,
    toggleTerminalBorder, navigateToSession, setActiveTabSession,
    activeTabId, activeTabSessionId, lastActiveTranscriptTabId,
    registerOperations, setActiveTab,
  ]);

  return (
    <TabControllerCtx.Provider value={value}>
      {children}
    </TabControllerCtx.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

export function useTabController(): TabControllerValue {
  const ctx = useContext(TabControllerCtx);
  if (!ctx) throw new Error('useTabController must be used within TabControllerProvider');
  return ctx;
}

/** Optional access — returns null outside provider (for gradual migration). */
export function useTabControllerOptional(): TabControllerValue | null {
  return useContext(TabControllerCtx);
}
