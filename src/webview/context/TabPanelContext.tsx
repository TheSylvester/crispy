/**
 * TabPanelContext — per-tab panel layout state
 *
 * Owns toolPanelOpen, toolPanelWidthPx
 * per-tab. Each tab gets its own independent panel state via TabPanelProvider.
 *
 * @module context/TabPanelContext
 */

import { createContext, useContext, useState, useMemo } from 'react';

// ============================================================================
// Per-Tab Panel State
// ============================================================================

interface TabPanelValue {
  toolPanelOpen: boolean;
  setToolPanelOpen: (open: boolean) => void;
  toolPanelWidthPx: number | null;
  setToolPanelWidthPx: (px: number | null) => void;
  settingsPinned: boolean;
  setSettingsPinned: (pinned: boolean) => void;
}

const TabPanelCtx = createContext<TabPanelValue | null>(null);

export function TabPanelProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [toolPanelWidthPx, setToolPanelWidthPx] = useState<number | null>(null);
  const [settingsPinned, setSettingsPinned] = useState(false);

  const value: TabPanelValue = useMemo(() => ({
    toolPanelOpen, setToolPanelOpen,
    toolPanelWidthPx, setToolPanelWidthPx,
    settingsPinned, setSettingsPinned,
  }), [toolPanelOpen, toolPanelWidthPx, settingsPinned]);

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

/** Optional access — returns null outside TabPanelProvider. */
export function useTabPanelOptional(): TabPanelValue | null {
  return useContext(TabPanelCtx);
}
