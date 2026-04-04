/**
 * TabPanelContext — per-tab panel layout state
 *
 * Owns toolPanelOpen, sidebarView, toolPanelWidthPx, fileViewerWidthPx
 * per-tab. In single-tab mode these default to false/null; the active tab
 * publishes its state to ActiveTabPanelBridge so TitleBar and AppLayout
 * (which sit above the tab layer) can read it.
 *
 * @module context/TabPanelContext
 */

import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react';

// Re-export SidebarView from PreferencesContext to avoid consumers needing both imports
export type SidebarView = 'files' | 'tools' | 'git';

// ============================================================================
// Per-Tab Panel State
// ============================================================================

interface TabPanelValue {
  toolPanelOpen: boolean;
  setToolPanelOpen: (open: boolean) => void;
  sidebarView: SidebarView;
  setSidebarView: (view: SidebarView) => void;
  toolPanelWidthPx: number | null;
  setToolPanelWidthPx: (px: number | null) => void;
  fileViewerWidthPx: number | null;
  setFileViewerWidthPx: (px: number | null) => void;
}

const TabPanelCtx = createContext<TabPanelValue | null>(null);

export function TabPanelProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('tools');
  const [toolPanelWidthPx, setToolPanelWidthPx] = useState<number | null>(null);
  const [fileViewerWidthPx, setFileViewerWidthPx] = useState<number | null>(null);

  // Push state changes to the app-level bridge
  const bridge = useContext(ActiveTabPanelBridgeCtx);
  const stateRef = useRef({ toolPanelOpen, sidebarView, toolPanelWidthPx, fileViewerWidthPx });
  stateRef.current = { toolPanelOpen, sidebarView, toolPanelWidthPx, fileViewerWidthPx };

  useEffect(() => {
    if (!bridge) return;
    bridge.publish(stateRef.current);
    // Register setters so the bridge can forward TitleBar writes back
    bridge.registerSetters({
      setToolPanelOpen, setSidebarView, setToolPanelWidthPx, setFileViewerWidthPx,
    });
  }, [bridge, toolPanelOpen, sidebarView, toolPanelWidthPx, fileViewerWidthPx]);

  const value: TabPanelValue = useMemo(() => ({
    toolPanelOpen, setToolPanelOpen,
    sidebarView, setSidebarView,
    toolPanelWidthPx, setToolPanelWidthPx,
    fileViewerWidthPx, setFileViewerWidthPx,
  }), [toolPanelOpen, sidebarView, toolPanelWidthPx, fileViewerWidthPx]);

  return (
    <TabPanelCtx.Provider value={value}>
      {children}
    </TabPanelCtx.Provider>
  );
}

/**
 * Read per-tab panel state. Throws if no TabPanelProvider in tree.
 */
export function useTabPanel(): TabPanelValue {
  const ctx = useContext(TabPanelCtx);
  if (!ctx) throw new Error('useTabPanel must be used within TabPanelProvider');
  return ctx;
}

// ============================================================================
// Active Tab Bridge — app-level state reflecting active tab's panels
// ============================================================================

interface PanelState {
  toolPanelOpen: boolean;
  sidebarView: SidebarView;
  toolPanelWidthPx: number | null;
  fileViewerWidthPx: number | null;
}

interface PanelSetters {
  setToolPanelOpen: (open: boolean) => void;
  setSidebarView: (view: SidebarView) => void;
  setToolPanelWidthPx: (px: number | null) => void;
  setFileViewerWidthPx: (px: number | null) => void;
}

interface ActiveTabPanelBridgeInner {
  publish: (state: PanelState) => void;
  registerSetters: (setters: PanelSetters) => void;
}

interface ActiveTabPanelBridgeValue extends PanelState, PanelSetters {}

const ActiveTabPanelBridgeCtx = createContext<ActiveTabPanelBridgeInner | null>(null);
const ActiveTabPanelReadCtx = createContext<ActiveTabPanelBridgeValue | null>(null);

export function ActiveTabPanelBridgeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<PanelState>({
    toolPanelOpen: false,
    sidebarView: 'tools',
    toolPanelWidthPx: null,
    fileViewerWidthPx: null,
  });
  const settersRef = useRef<PanelSetters | null>(null);

  const publish = useCallback((s: PanelState) => setState(s), []);
  const registerSetters = useCallback((s: PanelSetters) => { settersRef.current = s; }, []);

  // Write-through setters: update local state AND forward to active tab
  const setToolPanelOpen = useCallback((open: boolean) => {
    setState(prev => ({ ...prev, toolPanelOpen: open }));
    settersRef.current?.setToolPanelOpen(open);
  }, []);
  const setSidebarView = useCallback((view: SidebarView) => {
    setState(prev => ({ ...prev, sidebarView: view }));
    settersRef.current?.setSidebarView(view);
  }, []);
  const setToolPanelWidthPx = useCallback((px: number | null) => {
    setState(prev => ({ ...prev, toolPanelWidthPx: px }));
    settersRef.current?.setToolPanelWidthPx(px);
  }, []);
  const setFileViewerWidthPx = useCallback((px: number | null) => {
    setState(prev => ({ ...prev, fileViewerWidthPx: px }));
    settersRef.current?.setFileViewerWidthPx(px);
  }, []);

  const inner = useMemo(() => ({ publish, registerSetters }), [publish, registerSetters]);
  const readValue = useMemo(() => ({
    ...state, setToolPanelOpen, setSidebarView, setToolPanelWidthPx, setFileViewerWidthPx,
  }), [state, setToolPanelOpen, setSidebarView, setToolPanelWidthPx, setFileViewerWidthPx]);

  return (
    <ActiveTabPanelBridgeCtx.Provider value={inner}>
      <ActiveTabPanelReadCtx.Provider value={readValue}>
        {children}
      </ActiveTabPanelReadCtx.Provider>
    </ActiveTabPanelBridgeCtx.Provider>
  );
}

/** Read active tab's panel state + setters. For TitleBar, AppLayout. */
export function useActiveTabPanel(): ActiveTabPanelBridgeValue {
  const ctx = useContext(ActiveTabPanelReadCtx);
  if (!ctx) throw new Error('useActiveTabPanel must be used within ActiveTabPanelBridgeProvider');
  return ctx;
}
