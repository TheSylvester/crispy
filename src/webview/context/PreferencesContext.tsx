import { createContext, useContext, useState, ReactNode } from 'react';
import type { RenderMode } from '../types.js';

interface Preferences {
  renderMode: RenderMode;
  settingsPinned: boolean;
  sidebarCollapsed: boolean;
  toolPanelOpen: boolean;
  /** User-dragged panel width override (px). null = use auto-computed width. */
  toolPanelWidthPx: number | null;
  /** Coalesce consecutive Read/safe-tool entries into collapsed groups. */
  toolCoalescing: boolean;
}

interface PreferencesContextValue extends Preferences {
  setRenderMode: (mode: RenderMode) => void;
  setSettingsPinned: (pinned: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setToolPanelOpen: (open: boolean) => void;
  setToolPanelWidthPx: (px: number | null) => void;
  setToolCoalescing: (enabled: boolean) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [renderMode, setRenderMode] = useState<RenderMode>('rich');
  const [settingsPinned, setSettingsPinned] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [toolPanelWidthPx, setToolPanelWidthPx] = useState<number | null>(null);
  const [toolCoalescing, setToolCoalescing] = useState(true);

  const value: PreferencesContextValue = {
    renderMode,
    settingsPinned,
    sidebarCollapsed,
    toolPanelOpen,
    toolPanelWidthPx,
    toolCoalescing,
    setRenderMode,
    setSettingsPinned,
    setSidebarCollapsed,
    setToolPanelOpen,
    setToolPanelWidthPx,
    setToolCoalescing,
  };

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) {
    throw new Error('usePreferences must be used within a PreferencesProvider');
  }
  return context;
}
