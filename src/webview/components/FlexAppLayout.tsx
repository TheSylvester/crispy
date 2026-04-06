/**
 * FlexAppLayout — Multi-tab layout shell wrapping TranscriptViewer
 *
 * Owns the FlexLayout model, tab-to-session mapping, and registers
 * tab operations with TabControllerContext. Each tab gets its own
 * provider cascade (TabSessionProvider → ControlPanelProvider → ...).
 *
 * @module FlexAppLayout
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Layout, Model, TabNode, type IJsonModel } from 'flexlayout-react';
import { Actions, DockLocation } from '../lib/flexlayout-extras.js';
import 'flexlayout-react/style/dark.css';
import { TabSessionProvider, useTabSession } from '../context/TabSessionContext.js';
import { ControlPanelProvider } from '../context/ControlPanelContext.js';
import { TabPanelProvider } from '../context/TabPanelContext.js';
import { FileIndexProvider } from '../context/FileIndexContext.js';
import { FilePanelProvider } from '../context/FilePanelContext.js';
import { TabContainerProvider } from '../context/TabContainerContext.js';
import { ContentErrorBoundary } from './ErrorBoundary.js';
import { TranscriptViewer } from './TranscriptViewer.js';
import { GitPanel } from './git-panel/GitPanel.js';
import { FilePanel } from './file-panel/FilePanel.js';
import { FileViewerTab } from './file-panel/FileViewerTab.js';
import { XTermPanel } from './XTermPanel.js';
import { TabHeader } from './TabHeader.js';
import { TabLayout } from './TabLayout.js';
import { useTabController, type TabCreateConfig, type ForkConfig } from '../context/TabControllerContext.js';
import { useSession } from '../context/SessionContext.js';
import { useEnvironment } from '../context/EnvironmentContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { getSessionDisplayName } from '../utils/session-display.js';
import './flexlayout-overrides.css';

// ============================================================================
// Constants
// ============================================================================

const MAIN_TABSET_ID = 'main-tabset';
const TERMINAL_BORDER_TAB_ID = 'terminal-border-tab';
const GIT_BORDER_TAB_ID = 'git-border-tab';
const FILES_BORDER_TAB_ID = 'files-border-tab';

function makeDefaultModel(showTabStrip: boolean, gitPanelSide: 'left' | 'right' = 'left', showBorders = false): IJsonModel {
  return {
    global: {
      splitterSize: 4,
      tabEnableClose: showTabStrip,
      tabEnableRename: false,
      borderSize: 300,
      borderMinSize: 200,
      borderMaxSize: 600,
      borderEnableAutoHide: true,
    },
    borders: [
      ...(showBorders ? [{
        type: 'border' as const,
        location: gitPanelSide,
        size: 300,
        selected: -1, // closed by default
        children: [
          {
            type: 'tab' as const,
            id: GIT_BORDER_TAB_ID,
            name: 'Git',
            component: 'git',
            enableClose: false,
            enableDrag: false,
          },
          {
            type: 'tab' as const,
            id: FILES_BORDER_TAB_ID,
            name: 'Files',
            component: 'files',
            enableClose: false,
            enableDrag: false,
          },
        ],
      }] : []),
      ...(showBorders ? [{
        type: 'border' as const,
        location: 'bottom' as const,
        selected: -1,
        children: [
          {
            type: 'tab' as const,
            id: TERMINAL_BORDER_TAB_ID,
            name: 'Terminal',
            component: 'terminal',
            enableClose: false,
            enableDrag: false,
          },
        ],
      }] : []),
    ],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          id: MAIN_TABSET_ID,
          enableTabStrip: showTabStrip,
          children: [
            {
              type: 'tab',
              id: 'tab-initial',
              name: 'New Tab',
              component: 'transcript',
            },
          ],
        },
      ],
    },
  };
}

// ============================================================================
// Tab-to-Session Map (stable across renders via ref)
// ============================================================================

type TabSessionMap = Map<string, string | null>;

// ============================================================================
// Persistence helpers
// ============================================================================


// ============================================================================
// TabContent — inner wrapper per tab
// ============================================================================

function TabContent({ tabId, forkConfig, prefillContent }: { tabId: string; forkConfig?: ForkConfig | null; prefillContent?: string | null }): React.JSX.Element {
  const { effectiveSessionId } = useTabSession();
  return (
    <TabContainerProvider tabId={tabId}>
      <TabPanelProvider>
        <FileIndexProvider>
          <FilePanelProvider>
            <ControlPanelProvider selectedSessionId={effectiveSessionId} initialForkConfig={forkConfig} initialPrefill={prefillContent}>
              <ContentErrorBoundary>
                <TabHeader />
                <TabLayout>
                  <TranscriptViewer />
                </TabLayout>
              </ContentErrorBoundary>
            </ControlPanelProvider>
          </FilePanelProvider>
        </FileIndexProvider>
      </TabPanelProvider>
    </TabContainerProvider>
  );
}

// ============================================================================
// FlexAppLayout
// ============================================================================

export function FlexAppLayout(): React.JSX.Element {
  const controller = useTabController();
  const { sessions, selectedSessionId } = useSession();
  const envKind = useEnvironment();
  const isVscode = envKind === 'vscode';
  const { gitPanelSide } = usePreferences();

  // Fresh layout on every load — tabs are ephemeral like browser tabs
  const [initialState] = useState(() => {
    const showTabStrip = !isVscode;
    return {
      model: Model.fromJson(makeDefaultModel(showTabStrip, gitPanelSide, !isVscode)),  // borders only in standalone/desktop
      tabMap: new Map([['tab-initial', null]]) as TabSessionMap,
    };
  });

  const modelRef = useRef(initialState.model);
  const tabSessionMapRef = useRef<TabSessionMap>(initialState.tabMap);
  const gitPanelSideRef = useRef(gitPanelSide);
  const prevActiveTabRef = useRef<string | null>(null);

  // Determine initial active tab from the restored model
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    const tabset = initialState.model.getNodeById(MAIN_TABSET_ID);
    if (tabset && 'getSelectedNode' in tabset) {
      const selected = (tabset as any).getSelectedNode?.() as TabNode | undefined;
      if (selected) return selected.getId();
    }
    // Fallback: first tab in the map
    const firstKey = tabSessionMapRef.current.keys().next().value;
    return firstKey ?? null;
  });

  // Seed the previous-tab ref so the first model change doesn't spuriously focus
  if (prevActiveTabRef.current === null && activeTabId !== null) {
    prevActiveTabRef.current = activeTabId;
  }

  // Keep a render-triggering version of the map for tab names
  const [, forceUpdate] = useState(0);
  const bump = useCallback(() => {
    forceUpdate(n => n + 1);
  }, []);

  // Rebuild model borders when gitPanelSide changes
  useEffect(() => {
    if (gitPanelSide === gitPanelSideRef.current) return;
    gitPanelSideRef.current = gitPanelSide;
    const json = modelRef.current.toJson();
    if (json.borders) {
      for (const border of json.borders) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (border.children?.some((c: any) => c.component === 'git')) {
          border.location = gitPanelSide;
        }
      }
    }
    modelRef.current = Model.fromJson(json);
    bump();
  }, [gitPanelSide, bump]);

  // Stable refs for use in callbacks
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // --- Tab operations (registered with controller) ---

  const createTab = useCallback((config?: TabCreateConfig): string => {
    const tabId = `tab-${Date.now()}`;
    const component = config?.component ?? 'transcript';
    const sessionId = config?.sessionId ?? null;

    // Only track transcript tabs in the session map
    if (component === 'transcript') {
      tabSessionMapRef.current.set(tabId, sessionId);
    }

    const name = config?.name
      ?? (sessionId ? getTabName(sessionId, sessionsRef.current)
        : config?.forkConfig ? `Fork: ${getTabName(config.forkConfig.fromSessionId, sessionsRef.current)}`
        : 'New Tab');

    // Resolve target tabset — the requested one may no longer exist if tabs
    // were dragged around (FlexLayout removes empty tabsets).
    const model = modelRef.current;
    const requestedTabsetId = config?.tabsetId ?? MAIN_TABSET_ID;
    const targetTabsetId = model.getNodeById(requestedTabsetId)
      ? requestedTabsetId
      : model.getActiveTabset()?.getId() ?? MAIN_TABSET_ID;

    model.doAction(
      Actions.addNode(
        {
          type: 'tab',
          name,
          component,
          id: tabId,
          config: config?.forkConfig ? { forkConfig: config.forkConfig } : config?.config ?? undefined,
        },
        targetTabsetId,
        DockLocation.RIGHT,
        -1,
        true, // select the new tab
      ),
    );
    bump();
    return tabId;
  }, [bump]);

  const closeTab = useCallback((tabId: string) => {
    const isTranscriptTab = tabSessionMapRef.current.has(tabId);
    // Don't close the last transcript tab
    if (isTranscriptTab && tabSessionMapRef.current.size <= 1) return;
    if (isTranscriptTab) tabSessionMapRef.current.delete(tabId);
    modelRef.current.doAction(Actions.deleteTab(tabId));
    bump();
  }, [bump]);

  const activateTab = useCallback((tabId: string) => {
    modelRef.current.doAction(Actions.selectTab(tabId));
  }, []);

  const findTabBySession = useCallback((sessionId: string): string | null => {
    for (const [tabId, sid] of tabSessionMapRef.current) {
      if (sid === sessionId) return tabId;
    }
    return null;
  }, []);

  const getTabSession = useCallback((tabId: string): string | null => {
    return tabSessionMapRef.current.get(tabId) ?? null;
  }, []);

  /** Toggle the left border's Git panel open/closed */
  const toggleGitBorder = useCallback(() => {
    modelRef.current.doAction(Actions.selectTab(GIT_BORDER_TAB_ID));
  }, []);

  /** Toggle the Files border panel open/closed */
  const toggleFilesBorder = useCallback(() => {
    modelRef.current.doAction(Actions.selectTab(FILES_BORDER_TAB_ID));
  }, []);

  /** Toggle the Terminal border panel open/closed */
  const toggleTerminalBorder = useCallback(() => {
    modelRef.current.doAction(Actions.selectTab(TERMINAL_BORDER_TAB_ID));
  }, []);

  /** Equalize weights of all children in the root row */
  const equalizeLayout = useCallback(() => {
    const model = modelRef.current;
    const root = model.getRoot();
    const children = root.getChildren();
    if (children.length <= 1) return;
    const equalWeight = 100 / children.length;
    for (const child of children) {
      model.doAction(Actions.updateNodeAttributes(child.getId(), { weight: equalWeight }));
    }
  }, []);

  /** Find a file-viewer tab by file path */
  const findFileViewerTab = useCallback((path: string): string | null => {
    let found: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelRef.current.visitNodes((node: any) => {
      if (node.getType() === 'tab'
          && (node as TabNode).getComponent() === 'file-viewer'
          && node.getConfig()?.path === path) {
        found = node.getId();
      }
    });
    return found;
  }, []);

  /** Update a tab's config (e.g. line number for file-viewer) */
  const updateTabConfig = useCallback((tabId: string, config: Record<string, unknown>) => {
    modelRef.current.doAction(Actions.updateNodeAttributes(tabId, { config }));
  }, []);

  const findTabByComponent = useCallback((component: string): string | null => {
    let found: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelRef.current.visitNodes((node: any) => {
      if (node.getType() === 'tab' && (node as TabNode).getComponent() === component) {
        found = node.getId();
      }
    });
    return found;
  }, []);

  // Register operations with controller on mount
  useEffect(() => {
    controller.registerOperations({
      createTab,
      closeTab,
      activateTab,
      findTabBySession,
      getTabSession,
      findTabByComponent,
      toggleGitBorder,
      toggleFilesBorder,
      toggleTerminalBorder,
      findFileViewerTab,
      updateTabConfig,
      equalizeLayout,
    });
  }, [controller, createTab, closeTab, activateTab, findTabBySession, getTabSession, findTabByComponent, toggleGitBorder, toggleFilesBorder, toggleTerminalBorder, findFileViewerTab, updateTabConfig, equalizeLayout]);

  // Seed initial active tab so lastActiveTranscriptTabId is set even before
  // any model change fires (needed for file-viewer → transcript tab inserts)
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (activeTabId) {
      const sessionId = tabSessionMapRef.current.get(activeTabId) ?? null;
      controller.setActiveTab(activeTabId, sessionId, true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Sync initial session: when selectedSessionId is set (e.g. openSession bootstrap),
  //     assign it to the initial tab if that tab has no session yet. ---
  useEffect(() => {
    if (!selectedSessionId) return;
    const map = tabSessionMapRef.current;
    // If any tab already has this session, just activate it
    for (const [tabId, sid] of map) {
      if (sid === selectedSessionId) {
        activateTab(tabId);
        return;
      }
    }
    // Assign to active tab if it has no session
    if (activeTabId && !map.get(activeTabId)) {
      map.set(activeTabId, selectedSessionId);
      // Update tab name
      const name = getTabName(selectedSessionId, sessions);
      modelRef.current.doAction(Actions.renameTab(activeTabId, name));
      controller.setActiveTab(activeTabId, selectedSessionId);
      bump();
    }
  }, [selectedSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Auto-create empty tab when last tab is closed ---
  const ensureAtLeastOneTab = useCallback(() => {
    if (tabSessionMapRef.current.size === 0) {
      createTab();
    }
  }, [createTab]);

  // --- Prevent closing the last tab ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleAction = useCallback((action: any): any => {
    if (action.type === Actions.DELETE_TAB) {
      const tabId = action.data?.node;
      const isTranscriptTab = tabId && tabSessionMapRef.current.has(tabId);
      // Block closing the last transcript tab, but always allow closing non-transcript tabs
      if (isTranscriptTab && tabSessionMapRef.current.size <= 1) return undefined;
    }
    return action;
  }, []);

  // --- onModelChange: detect tab activations and deletions ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleModelChange = useCallback((_model: Model, action: any) => {
    if (action.type === Actions.SELECT_TAB || action.type === Actions.ADD_NODE ||
        action.type === Actions.SET_ACTIVE_TABSET || action.type === Actions.MOVE_NODE) {
      // Find the selected tab in the currently active tabset (works across splits)
      const tabset = modelRef.current.getActiveTabset();
      if (tabset) {
        const selected = (tabset as any).getSelectedNode?.() as TabNode | undefined;
        if (selected) {
          const tabId = selected.getId();
          const sessionId = tabSessionMapRef.current.get(tabId) ?? null;
          const isTranscriptTab = !selected.getComponent() || selected.getComponent() === 'transcript';
          const tabChanged = tabId !== prevActiveTabRef.current;
          prevActiveTabRef.current = tabId;
          setActiveTabId(tabId);
          controller.setActiveTab(tabId, sessionId, isTranscriptTab);
          // Only focus when the active tab actually changed (not on internal layout updates)
          if (tabChanged) {
            setTimeout(() => window.postMessage({ kind: 'focusInput' }, '*'), 50);
          }
        }
      }
    } else if (action.type === Actions.DELETE_TAB) {
      // Tab was closed — clean up and ensure at least one tab
      const deletedTabId = action.data?.node ?? null;
      if (deletedTabId) {
        tabSessionMapRef.current.delete(deletedTabId);
      }
      // Use setTimeout to avoid dispatching during render
      setTimeout(() => {
        ensureAtLeastOneTab();
        window.postMessage({ kind: 'focusInput' }, '*');
      }, 0);
      bump();
    }
  }, [controller, ensureAtLeastOneTab, bump]);

  // --- Tab rendering customization ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleRenderTab = useCallback((node: TabNode, renderValues: any) => {
    const tabId = node.getId();
    // Non-transcript tabs use FlexLayout's node name directly
    if (!tabSessionMapRef.current.has(tabId)) return;
    const sessionId = tabSessionMapRef.current.get(tabId);
    if (sessionId) {
      const name = getTabName(sessionId, sessionsRef.current);
      renderValues.content = name;
    } else {
      renderValues.content = 'New Tab';
    }
  }, []);

  // Add "+" button to tabset header (multi-tab only)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleRenderTabSet = useCallback((node: any, renderValues: any) => {
    if (isVscode) return; // VS Code uses native editor tabs
    // Don't add "+" to border panels (git, files, terminal)
    if (node.getType() === 'border') return;
    const tabsetId = node.getId() as string;
    renderValues.stickyButtons.push(
      <button
        key="add-tab"
        className="crispy-tab-add-btn"
        title="New tab"
        onClick={() => createTab({ tabsetId })}
      >
        +
      </button>,
    );
  }, [createTab, isVscode]);

  // --- Factory: create per-tab provider cascade ---
  const factory = useCallback((node: TabNode): React.JSX.Element | null => {
    if (node.getComponent() === 'transcript') {
      const tabId = node.getId();
      const sessionId = tabSessionMapRef.current.get(tabId) ?? null;

      // Callback for when the tab's session changes (user selects a session within the tab)
      const onSessionChange = (newSessionId: string | null) => {
        tabSessionMapRef.current.set(tabId, newSessionId);
        // Update tab name
        const name = newSessionId ? getTabName(newSessionId, sessionsRef.current) : 'New Tab';
        modelRef.current.doAction(Actions.renameTab(tabId, name));
        // If this is the active tab, update the controller
        if (tabId === activeTabIdRef.current) {
          controller.setActiveTabSession(newSessionId);
        }
        bump();
      };

      // Read fork config from FlexLayout node config (set during createTab)
      const nodeConfig = node.getConfig();
      const forkConfig = nodeConfig?.forkConfig as ForkConfig | undefined;
      const prefillContent = nodeConfig?.prefillContent as string | undefined;

      return (
        <TabSessionProvider sessionId={sessionId} onSessionChange={onSessionChange}>
          <TabContent tabId={tabId} forkConfig={forkConfig} prefillContent={prefillContent} />
        </TabSessionProvider>
      );
    } else if (node.getComponent() === 'git') {
      return (
        <ContentErrorBoundary>
          <GitPanel mode="tab" />
        </ContentErrorBoundary>
      );
    } else if (node.getComponent() === 'files') {
      return (
        <FileIndexProvider>
          <FilePanelProvider>
            <ContentErrorBoundary>
              <FilePanel mode="tab" />
            </ContentErrorBoundary>
          </FilePanelProvider>
        </FileIndexProvider>
      );
    } else if (node.getComponent() === 'terminal') {
      return (
        <ContentErrorBoundary>
          <XTermPanel node={node} />
        </ContentErrorBoundary>
      );
    } else if (node.getComponent() === 'file-viewer') {
      const config = node.getConfig() as { path: string; relativePath?: string; line?: number } | undefined;
      if (!config?.path) return null;
      return (
        <FileIndexProvider>
          <FilePanelProvider>
            <ContentErrorBoundary>
              <FileViewerTab path={config.path} relativePath={config.relativePath} line={config.line} />
            </ContentErrorBoundary>
          </FilePanelProvider>
        </FileIndexProvider>
      );
    }
    return null;
  }, [controller, bump]);

  // --- Tab keyboard shortcuts (multi-tab only) ---
  useEffect(() => {
    if (isVscode) return; // VS Code uses native editor tabs
    const handleKeyDown = (e: KeyboardEvent) => {
      // Dev server / Tauri: Alt+N (new), Alt+W (close), Alt+[/] (cycle)
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        if (e.key === 'n') {
          e.preventDefault();
          createTab();
        } else if (e.key === 'w') {
          e.preventDefault();
          if (activeTabId) closeTab(activeTabId);
        } else if (e.key === ']') {
          e.preventDefault();
          cycleTab(1);
        } else if (e.key === '[') {
          e.preventDefault();
          cycleTab(-1);
        } else if (e.key === 'e') {
          e.preventDefault();
          equalizeLayout();
        } else if (e.key === 'j') {
          e.preventDefault();
          toggleTerminalBorder();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVscode, activeTabId, createTab, closeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cycle through tabs in order
  function cycleTab(direction: 1 | -1) {
    const tabIds = Array.from(tabSessionMapRef.current.keys());
    if (tabIds.length <= 1) return;
    const currentIdx = activeTabId ? tabIds.indexOf(activeTabId) : 0;
    const nextIdx = (currentIdx + direction + tabIds.length) % tabIds.length;
    activateTab(tabIds[nextIdx]);
  }

  return (
    <Layout
      model={modelRef.current}
      factory={factory}
      onAction={handleAction}
      onModelChange={handleModelChange}
      onRenderTab={handleRenderTab}
      onRenderTabSet={handleRenderTabSet}
    />
  );
}

// ============================================================================
// Helpers
// ============================================================================

function getTabName(sessionId: string, sessions: Array<{ sessionId: string; title?: string; vendor?: string }>): string {
  const session = sessions.find(s => s.sessionId === sessionId);
  if (session) {
    const name = getSessionDisplayName(session as any);
    return name.length > 42 ? name.slice(0, 42) + '\u2026' : name;
  }
  return sessionId.slice(0, 8) + '\u2026';
}
