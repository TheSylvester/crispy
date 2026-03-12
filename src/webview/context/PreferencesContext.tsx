/**
 * Preferences Context — persisted + ephemeral UI state
 *
 * Only toolPanelAutoOpen is persisted via the settings RPC.
 * All other preferences (renderMode, debugMode, panel state) are per-window
 * ephemeral state managed with plain useState.
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
  settingsPinned: boolean;
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
  setToolPanelAutoOpen: (enabled: boolean) => void;
  setCondensedToolMode: (enabled: boolean) => void;
  setBadgeStyle: (style: BadgeStyle) => void;
  setBashBlockInIcons: (enabled: boolean) => void;
  setSidebarView: (view: SidebarView) => void;
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

  const [renderMode, setRenderMode] = useState<RenderMode>(getInitialRenderMode);
  const [debugMode, setDebugMode] = useState(false);
  const [settingsPinned, setSettingsPinned] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [toolPanelOpen, setToolPanelOpen] = useState(false);
  const [toolPanelWidthPx, setToolPanelWidthPx] = useState<number | null>(null);
  const [toolPanelMode, setToolPanelMode] = useState<ToolPanelMode>('inspector');
  const [toolViewOverride, setToolViewOverride] = useState<ToolViewOverride>(null);
  const [condensedToolMode, setCondensedToolMode] = useState(false);
  const [badgeStyle, setBadgeStyle] = useState<BadgeStyle>('frosted');
  const [sidebarView, setSidebarView] = useState<SidebarView>('tools');

  // ============================================================================
  // Persisted preference — toolPanelAutoOpen only
  // ============================================================================

  const [toolPanelAutoOpen, setToolPanelAutoOpenLocal] = useState(false);
  const [bashBlockInIcons, setBashBlockInIconsLocal] = useState(false);

  /** Latest known revision from settings RPC or incoming events. */
  const revisionRef = useRef(0);
  /** True while a debounced write is pending — blocks incoming event overwrites. */
  const pendingWriteRef = useRef(false);
  /** Timer for debounced persist calls. */
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Seed toolPanelAutoOpen from settings on mount
  useEffect(() => {
    transport.getSettings().then((snapshot) => {
      revisionRef.current = snapshot.revision;
      setToolPanelAutoOpenLocal(snapshot.settings.preferences.toolPanelAutoOpen);
      setBashBlockInIconsLocal(snapshot.settings.preferences.bashBlockInIcons);
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
        setToolPanelAutoOpenLocal(snapshot.settings.preferences.toolPanelAutoOpen);
        setBashBlockInIconsLocal(snapshot.settings.preferences.bashBlockInIcons);
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

  const setToolPanelAutoOpen = useCallback((enabled: boolean) => {
    setToolPanelAutoOpenLocal(enabled);
    persistPreference({ toolPanelAutoOpen: enabled });
  }, [persistPreference]);

  const setBashBlockInIcons = useCallback((enabled: boolean) => {
    setBashBlockInIconsLocal(enabled);
    persistPreference({ bashBlockInIcons: enabled });
  }, [persistPreference]);

  // ============================================================================
  // Context value
  // ============================================================================

  const value: PreferencesContextValue = useMemo(() => ({
    renderMode,
    settingsPinned,
    sidebarCollapsed,
    toolPanelOpen,
    toolPanelWidthPx,
    toolPanelMode,
    toolViewOverride,
    debugMode,
    toolPanelAutoOpen,
    condensedToolMode,
    badgeStyle,
    bashBlockInIcons,
    sidebarView,
    setRenderMode,
    setSettingsPinned,
    setSidebarCollapsed,
    setToolPanelOpen,
    setToolPanelWidthPx,
    setToolPanelMode,
    setToolViewOverride,
    setDebugMode,
    setToolPanelAutoOpen,
    setCondensedToolMode,
    setBadgeStyle,
    setBashBlockInIcons,
    setSidebarView,
  }), [
    renderMode,
    settingsPinned,
    sidebarCollapsed,
    toolPanelOpen,
    toolPanelWidthPx,
    toolPanelMode,
    toolViewOverride,
    debugMode,
    toolPanelAutoOpen,
    condensedToolMode,
    badgeStyle,
    bashBlockInIcons,
    sidebarView,
    setRenderMode,
    setSettingsPinned,
    setSidebarCollapsed,
    setToolPanelOpen,
    setToolPanelWidthPx,
    setToolPanelMode,
    setToolViewOverride,
    setDebugMode,
    setToolPanelAutoOpen,
    setCondensedToolMode,
    setBadgeStyle,
    setBashBlockInIcons,
    setSidebarView,
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
