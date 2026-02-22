import { createContext, useContext, useState, ReactNode } from 'react';
import type { RenderMode } from '../types.js';

/** Debug override for tool view mode. null = automatic (normal selectView logic). */
export type ToolViewOverride = 'compact' | 'expanded' | null;

/** Tool panel mode: inspector shows active/focused tools, viewport mirrors scroll position. */
export type ToolPanelMode = 'inspector' | 'viewport';

interface Preferences {
  renderMode: RenderMode;
  settingsPinned: boolean;
  sidebarCollapsed: boolean;
  toolPanelOpen: boolean;
  /** User-dragged panel width override (px). null = use auto-computed width. */
  toolPanelWidthPx: number | null;
  /** Tool panel filtering mode. Inspector = active/focused only; viewport = all visible. */
  toolPanelMode: ToolPanelMode;
  /** Debug: force all tools to render in a specific view mode. null = auto. */
  toolViewOverride: ToolViewOverride;
  /** Show debug UI (playback controls, tool view override). On by default during development. */
  debugMode: boolean;
  /** Whether the file panel sidebar is open. */
  filePanelOpen: boolean;
  /** User-dragged file panel width override (px). null = use auto-computed width. */
  filePanelWidthPx: number | null;
}

interface PreferencesContextValue extends Preferences {
  setRenderMode: (mode: RenderMode) => void;
  setSettingsPinned: (pinned: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setToolPanelOpen: (open: boolean) => void;
  setToolPanelWidthPx: (px: number | null) => void;
  setToolPanelMode: (mode: ToolPanelMode) => void;
  setToolViewOverride: (override: ToolViewOverride) => void;
  setDebugMode: (enabled: boolean) => void;
  setFilePanelOpen: (open: boolean) => void;
  setFilePanelWidthPx: (px: number | null) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

/**
 * Read initial render mode from URL (e.g., ?mode=blocks), default to 'blocks'.
 */
function getInitialRenderMode(): RenderMode {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  if (mode === 'yaml' || mode === 'compact' || mode === 'blocks') {
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
  const [toolPanelMode, setToolPanelMode] = useState<ToolPanelMode>('inspector');
  const [toolViewOverride, setToolViewOverride] = useState<ToolViewOverride>(null);
  const [debugMode, setDebugMode] = useState(true);
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [filePanelWidthPx, setFilePanelWidthPx] = useState<number | null>(null);

  const value: PreferencesContextValue = {
    renderMode,
    settingsPinned,
    sidebarCollapsed,
    toolPanelOpen,
    toolPanelWidthPx,
    toolPanelMode,
    toolViewOverride,
    debugMode,
    setRenderMode,
    setSettingsPinned,
    setSidebarCollapsed,
    setToolPanelOpen,
    setToolPanelWidthPx,
    setToolPanelMode,
    setToolViewOverride,
    setDebugMode,
    filePanelOpen,
    filePanelWidthPx,
    setFilePanelOpen,
    setFilePanelWidthPx,
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
