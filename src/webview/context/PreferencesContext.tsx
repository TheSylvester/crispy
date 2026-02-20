import { createContext, useContext, useState, ReactNode } from 'react';
import type { RenderMode } from '../types.js';

/** Debug override for tool view mode. null = automatic (normal selectView logic). */
export type ToolViewOverride = 'compact' | 'expanded' | null;

interface Preferences {
  renderMode: RenderMode;
  settingsPinned: boolean;
  sidebarCollapsed: boolean;
  toolPanelOpen: boolean;
  /** User-dragged panel width override (px). null = use auto-computed width. */
  toolPanelWidthPx: number | null;
  /** Coalesce consecutive Read/safe-tool entries into collapsed groups. */
  toolCoalescing: boolean;
  /** Debug: force all tools to render in a specific view mode. null = auto. */
  toolViewOverride: ToolViewOverride;
  /** Show debug UI (playback controls, tool view override). On by default during development. */
  debugMode: boolean;
}

interface PreferencesContextValue extends Preferences {
  setRenderMode: (mode: RenderMode) => void;
  setSettingsPinned: (pinned: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setToolPanelOpen: (open: boolean) => void;
  setToolPanelWidthPx: (px: number | null) => void;
  setToolCoalescing: (enabled: boolean) => void;
  setToolViewOverride: (override: ToolViewOverride) => void;
  setDebugMode: (enabled: boolean) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

/**
 * Read initial render mode from URL (e.g., ?mode=rich), default to 'blocks'.
 */
function getInitialRenderMode(): RenderMode {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  if (mode === 'yaml' || mode === 'compact' || mode === 'rich' || mode === 'blocks') {
    return mode;
  }
  return 'blocks';
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [renderMode, setRenderMode] = useState<RenderMode>(getInitialRenderMode);
  const [settingsPinned, setSettingsPinned] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [toolPanelWidthPx, setToolPanelWidthPx] = useState<number | null>(null);
  const [toolCoalescing, setToolCoalescing] = useState(true);
  const [toolViewOverride, setToolViewOverride] = useState<ToolViewOverride>(null);
  const [debugMode, setDebugMode] = useState(true);

  const value: PreferencesContextValue = {
    renderMode,
    settingsPinned,
    sidebarCollapsed,
    toolPanelOpen,
    toolPanelWidthPx,
    toolCoalescing,
    toolViewOverride,
    debugMode,
    setRenderMode,
    setSettingsPinned,
    setSidebarCollapsed,
    setToolPanelOpen,
    setToolPanelWidthPx,
    setToolCoalescing,
    setToolViewOverride,
    setDebugMode,
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
