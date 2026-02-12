import { createContext, useContext, useState, ReactNode } from 'react';
import type { RenderMode } from '../types.js';

interface Preferences {
  renderMode: RenderMode;
  settingsPinned: boolean;
  sidebarCollapsed: boolean;
}

interface PreferencesContextValue extends Preferences {
  setRenderMode: (mode: RenderMode) => void;
  setSettingsPinned: (pinned: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [renderMode, setRenderMode] = useState<RenderMode>('rich');
  const [settingsPinned, setSettingsPinned] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);

  const value: PreferencesContextValue = {
    renderMode,
    settingsPinned,
    sidebarCollapsed,
    setRenderMode,
    setSettingsPinned,
    setSidebarCollapsed,
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
