/**
 * Preferences Context — persisted + ephemeral UI state
 *
 * Persisted prefs (renderMode, badgeStyle, toolPanelAutoOpen, bashBlockInIcons)
 * are synced to settings.json via debounced RPC.
 * All other preferences (debugMode, panel state) are per-window ephemeral state.
 *
 * @module PreferencesContext
 */

import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, ReactNode } from 'react';
import type { RenderMode } from '../types.js';
import { useTransport } from './TransportContext.js';
import { SETTINGS_CHANNEL_ID } from '../../core/settings/events.js';
import type { SettingsChangedGlobalEvent } from '../../core/settings/events.js';
import type { SettingsPreferences } from '../../core/settings/types.js';

/** Debug override for tool view mode. null = automatic (normal selectView logic). */
export type ToolViewOverride = 'compact' | 'expanded' | null;

/** Tool panel mode: inspector shows active/focused tools, viewport mirrors scroll position. */
export type ToolPanelMode = 'inspector' | 'viewport';

/** Badge style for tool name pills. */
export type BadgeStyle = 'solid' | 'tinted' | 'frosted';

/** Which view is shown in the unified right sidebar. */
export type SidebarView = 'files' | 'tools';

interface Preferences {
  renderMode: RenderMode;
  sidebarCollapsed: boolean;
  toolPanelOpen: boolean;
  /** User-dragged panel width override (px). null = use auto-computed width. */
  toolPanelWidthPx: number | null;
  /** Tool panel filtering mode. Inspector = active/focused only; viewport = all visible. */
  toolPanelMode: ToolPanelMode;
  /** Debug: force all tools to render in a specific view mode. null = auto. */
  toolViewOverride: ToolViewOverride;
  /** Show debug UI (playback controls, tool view override). Off by default. */
  debugMode: boolean;
  /** Auto-open tool panel on first tool use in a session. On by default. */
  toolPanelAutoOpen: boolean;
  /** Condensed tool mode: tools render as dot-lines instead of full compact rows. Off by default. */
  condensedToolMode: boolean;
  /** Badge style for tool name pills. */
  badgeStyle: BadgeStyle;
  /** In Icons mode, render Bash as a full block instead of condensed single-line. */
  bashBlockInIcons: boolean;
  /** Which view is shown in the unified right sidebar. */
  sidebarView: SidebarView;
  /** User-dragged file viewer panel width override (px). null = use auto-computed width. */
  fileViewerWidthPx: number | null;
  /** Auto-invoke /reflect after creating implementation plans. */
  autoReflect: boolean;
  /** Which side the Git border panel docks to. */
  gitPanelSide: 'left' | 'right';
  /** Whether the Rosie bot tracker is enabled. Read-only from settings. */
  rosieBotEnabled: boolean;
}

interface PreferencesContextValue extends Preferences {
  setRenderMode: (mode: RenderMode) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setToolPanelOpen: (open: boolean) => void;
  setToolPanelWidthPx: (px: number | null) => void;
  setFileViewerWidthPx: (px: number | null) => void;
  setToolPanelMode: (mode: ToolPanelMode) => void;
  setToolViewOverride: (override: ToolViewOverride) => void;
  setDebugMode: (enabled: boolean) => void;
  setToolPanelAutoOpen: (enabled: boolean) => void;
  setAutoReflect: (enabled: boolean) => void;
  setCondensedToolMode: (enabled: boolean) => void;
  setBadgeStyle: (style: BadgeStyle) => void;
  setBashBlockInIcons: (enabled: boolean) => void;
  setSidebarView: (view: SidebarView) => void;
  setGitPanelSide: (side: 'left' | 'right') => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

/**
 * Read initial render mode from URL (e.g., ?mode=blocks), default to 'blocks'.
 */
function getInitialRenderMode(): RenderMode {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  if (mode === 'yaml' || mode === 'compact' || mode === 'blocks' || mode === 'icons') {
    return mode;
  }
  return 'icons';
}

/** Debounce delay for persisted writes (ms). */
const PERSIST_DEBOUNCE_MS = 150;

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const transport = useTransport();

  // ============================================================================
  // Ephemeral preferences — per-window transient UI state
  // ============================================================================

  const [debugMode, setDebugMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [toolPanelWidthPx, setToolPanelWidthPx] = useState<number | null>(null);
  const [fileViewerWidthPx, setFileViewerWidthPx] = useState<number | null>(null);
  const [toolPanelMode, setToolPanelMode] = useState<ToolPanelMode>('inspector');
  const [toolViewOverride, setToolViewOverride] = useState<ToolViewOverride>(null);
  const [condensedToolMode, setCondensedToolMode] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('tools');
  const [rosieBotEnabled, setRosieBotEnabled] = useState(false);

  // ============================================================================
  // Persisted preferences — synced to settings.json
  // ============================================================================

  const [renderMode, setRenderModeLocal] = useState<RenderMode>(getInitialRenderMode);
  const [badgeStyle, setBadgeStyleLocal] = useState<BadgeStyle>('frosted');
  const [toolPanelAutoOpen, setToolPanelAutoOpenLocal] = useState(false);
  const [autoReflect, setAutoReflectLocal] = useState(true);
  const [bashBlockInIcons, setBashBlockInIconsLocal] = useState(true);
  const [gitPanelSide, setGitPanelSideLocal] = useState<'left' | 'right'>('left');

  /** Latest known revision from settings RPC or incoming events. */
  const revisionRef = useRef(0);
  /** True while a debounced write is pending — blocks incoming event overwrites. */
  const pendingWriteRef = useRef(false);
  /** Timer for debounced persist calls. */
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Seed persisted preferences from settings on mount
  useEffect(() => {
    transport.getSettings().then((snapshot) => {
      revisionRef.current = snapshot.revision;
      const prefs = snapshot.settings.preferences;
      // URL ?mode= param takes priority over persisted setting (dev override)
      const urlMode = new URLSearchParams(window.location.search).get('mode');
      if (!urlMode && prefs.renderMode) setRenderModeLocal(prefs.renderMode as RenderMode);
      if (prefs.badgeStyle) setBadgeStyleLocal(prefs.badgeStyle as BadgeStyle);
      setToolPanelAutoOpenLocal(prefs.toolPanelAutoOpen);
      setAutoReflectLocal(prefs.autoReflect ?? true);
      setBashBlockInIconsLocal(prefs.bashBlockInIcons);
      if (prefs.gitPanelSide) setGitPanelSideLocal(prefs.gitPanelSide);
      setRosieBotEnabled(snapshot.settings.rosie?.bot?.enabled ?? false);
    }).catch((err) => {
      console.error('[PreferencesContext] Failed to load settings:', err);
    });
  }, [transport]);

  // Listen for cross-panel settings changes (toolPanelAutoOpen only)
  useEffect(() => {
    return transport.onEvent((sessionId, event) => {
      if (sessionId !== SETTINGS_CHANNEL_ID) return;
      if (event.type !== 'settings_snapshot') return;

      const settingsEvent = event as unknown as SettingsChangedGlobalEvent;
      const { snapshot, changedSections } = settingsEvent;

      if (snapshot.revision <= revisionRef.current) return;
      if (pendingWriteRef.current) return;

      revisionRef.current = snapshot.revision;

      if (changedSections.includes('preferences')) {
        const prefs = snapshot.settings.preferences;
        const urlMode = new URLSearchParams(window.location.search).get('mode');
        if (!urlMode && prefs.renderMode) setRenderModeLocal(prefs.renderMode as RenderMode);
        if (prefs.badgeStyle) setBadgeStyleLocal(prefs.badgeStyle as BadgeStyle);
        setToolPanelAutoOpenLocal(prefs.toolPanelAutoOpen);
        setAutoReflectLocal(prefs.autoReflect ?? true);
        setBashBlockInIconsLocal(prefs.bashBlockInIcons);
        if (prefs.gitPanelSide) setGitPanelSideLocal(prefs.gitPanelSide);
      }
      if (changedSections.includes('rosie')) {
        setRosieBotEnabled(snapshot.settings.rosie?.bot?.enabled ?? false);
      }
    });
  }, [transport]);

  // Debounced write helper
  const persistPreference = useCallback((patch: Partial<SettingsPreferences>) => {
    pendingWriteRef.current = true;

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      transport.updateSettings(
        { preferences: patch },
        { expectedRevision: revisionRef.current },
      ).then((snapshot) => {
        revisionRef.current = snapshot.revision;
        pendingWriteRef.current = false;
      }).catch((err) => {
        pendingWriteRef.current = false;

        if (String(err).includes('SETTINGS_CONFLICT')) {
          transport.getSettings().then((latestSnapshot) => {
            revisionRef.current = latestSnapshot.revision;
            return transport.updateSettings(
              { preferences: patch },
              { expectedRevision: latestSnapshot.revision },
            );
          }).then((retrySnapshot) => {
            revisionRef.current = retrySnapshot.revision;
          }).catch((retryErr) => {
            console.error('[PreferencesContext] Retry failed:', retryErr);
          });
        } else {
          console.error('[PreferencesContext] updateSettings failed:', err);
        }
      });
    }, PERSIST_DEBOUNCE_MS);
  }, [transport]);

  const setRenderMode = useCallback((mode: RenderMode) => {
    setRenderModeLocal(mode);
    persistPreference({ renderMode: mode });
  }, [persistPreference]);

  const setBadgeStyle = useCallback((style: BadgeStyle) => {
    setBadgeStyleLocal(style);
    persistPreference({ badgeStyle: style });
  }, [persistPreference]);

  const setToolPanelAutoOpen = useCallback((enabled: boolean) => {
    setToolPanelAutoOpenLocal(enabled);
    persistPreference({ toolPanelAutoOpen: enabled });
  }, [persistPreference]);

  const setAutoReflect = useCallback((enabled: boolean) => {
    setAutoReflectLocal(enabled);
    persistPreference({ autoReflect: enabled });
  }, [persistPreference]);

  const setBashBlockInIcons = useCallback((enabled: boolean) => {
    setBashBlockInIconsLocal(enabled);
    persistPreference({ bashBlockInIcons: enabled });
  }, [persistPreference]);

  const setGitPanelSide = useCallback((side: 'left' | 'right') => {
    setGitPanelSideLocal(side);
    persistPreference({ gitPanelSide: side });
  }, [persistPreference]);

  // ============================================================================
  // Context value
  // ============================================================================

  const value: PreferencesContextValue = useMemo(() => ({
    renderMode,

    sidebarCollapsed,
    toolPanelOpen,
    toolPanelWidthPx,
    fileViewerWidthPx,
    toolPanelMode,
    toolViewOverride,
    debugMode,
    toolPanelAutoOpen,
    autoReflect,
    condensedToolMode,
    badgeStyle,
    bashBlockInIcons,
    sidebarView,
    rosieBotEnabled,
    setRenderMode,

    setSidebarCollapsed,
    setToolPanelOpen,
    setToolPanelWidthPx,
    setFileViewerWidthPx,
    setToolPanelMode,
    setToolViewOverride,
    setDebugMode,
    setToolPanelAutoOpen,
    setAutoReflect,
    setCondensedToolMode,
    setBadgeStyle,
    setBashBlockInIcons,
    setSidebarView,
    gitPanelSide,
    setGitPanelSide,
  }), [
    renderMode,

    sidebarCollapsed,
    toolPanelOpen,
    toolPanelWidthPx,
    fileViewerWidthPx,
    toolPanelMode,
    toolViewOverride,
    debugMode,
    toolPanelAutoOpen,
    autoReflect,
    condensedToolMode,
    badgeStyle,
    bashBlockInIcons,
    sidebarView,
    gitPanelSide,
    rosieBotEnabled,
    setRenderMode,

    setSidebarCollapsed,
    setToolPanelOpen,
    setToolPanelWidthPx,
    setFileViewerWidthPx,
    setToolPanelMode,
    setToolViewOverride,
    setDebugMode,
    setToolPanelAutoOpen,
    setAutoReflect,
    setCondensedToolMode,
    setBadgeStyle,
    setBashBlockInIcons,
    setSidebarView,
    setGitPanelSide,
  ]);

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
