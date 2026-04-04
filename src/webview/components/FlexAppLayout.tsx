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
import { useTabController, type TabCreateConfig, type ForkConfig } from '../context/TabControllerContext.js';
import { useSession } from '../context/SessionContext.js';
import { useEnvironment } from '../context/EnvironmentContext.js';
import { getSessionDisplayName } from '../utils/session-display.js';
import './flexlayout-overrides.css';

// ============================================================================
// Constants
// ============================================================================

const MAIN_TABSET_ID = 'main-tabset';

const DEFAULT_MODEL: IJsonModel = {
  global: {
    splitterSize: 4,
    tabEnableClose: true,
    tabEnableRename: false,
  },
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        id: MAIN_TABSET_ID,
        enableTabStrip: true,
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

// ============================================================================
// Tab-to-Session Map (stable across renders via ref)
// ============================================================================

type TabSessionMap = Map<string, string | null>;

// ============================================================================
// TabContent — inner wrapper per tab
// ============================================================================

function TabContent({ isActive, forkConfig }: { isActive: boolean; forkConfig?: ForkConfig | null }): React.JSX.Element {
  const { effectiveSessionId } = useTabSession();
  return (
    <TabContainerProvider isActiveTab={isActive}>
      <TabPanelProvider>
        <FileIndexProvider>
          <FilePanelProvider>
            <ControlPanelProvider selectedSessionId={effectiveSessionId} initialForkConfig={forkConfig}>
              <ContentErrorBoundary>
                <TranscriptViewer />
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
  const modelRef = useRef(Model.fromJson(DEFAULT_MODEL));
  const tabSessionMapRef = useRef<TabSessionMap>(new Map([['tab-initial', null]]));
  const [activeTabId, setActiveTabId] = useState<string | null>('tab-initial');

  // Keep a render-triggering version of the map for tab names
  const [, forceUpdate] = useState(0);
  const bump = useCallback(() => forceUpdate(n => n + 1), []);

  // Stable refs for use in callbacks
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;

  // --- Tab operations (registered with controller) ---

  const createTab = useCallback((config?: TabCreateConfig): string => {
    const tabId = `tab-${Date.now()}`;
    const sessionId = config?.sessionId ?? null;
    tabSessionMapRef.current.set(tabId, sessionId);

    modelRef.current.doAction(
      Actions.addNode(
        {
          type: 'tab',
          name: sessionId ? getTabName(sessionId, sessionsRef.current) : 'New Tab',
          component: 'transcript',
          id: tabId,
          config: config?.forkConfig ? { forkConfig: config.forkConfig } : undefined,
        },
        MAIN_TABSET_ID,
        DockLocation.CENTER,
        -1,
        true, // select the new tab
      ),
    );
    bump();
    return tabId;
  }, [bump]);

  const closeTab = useCallback((tabId: string) => {
    tabSessionMapRef.current.delete(tabId);
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

  // Register operations with controller on mount
  useEffect(() => {
    controller.registerOperations({
      createTab,
      closeTab,
      activateTab,
      findTabBySession,
      getTabSession,
    });
  }, [controller, createTab, closeTab, activateTab, findTabBySession, getTabSession]);

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

  // --- onModelChange: detect tab activations and deletions ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleModelChange = useCallback((_model: Model, action: any) => {
    if (action.type === Actions.SELECT_TAB || action.type === Actions.ADD_NODE) {
      // Find the selected tab in the main tabset
      const tabset = modelRef.current.getNodeById(MAIN_TABSET_ID);
      if (tabset && 'getSelectedNode' in tabset) {
        const selected = (tabset as any).getSelectedNode?.() as TabNode | undefined;
        if (selected) {
          const tabId = selected.getId();
          const sessionId = tabSessionMapRef.current.get(tabId) ?? null;
          setActiveTabId(tabId);
          controller.setActiveTab(tabId, sessionId);
          // Focus the new tab's input after activation
          setTimeout(() => window.postMessage({ kind: 'focusInput' }, '*'), 50);
        }
      }
    } else if (action.type === Actions.DELETE_TAB) {
      // Tab was closed — clean up and ensure at least one tab
      const data = action as any;
      const deletedTabId = data.data?.node ?? null;
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
    const sessionId = tabSessionMapRef.current.get(tabId);
    if (sessionId) {
      const name = getTabName(sessionId, sessionsRef.current);
      renderValues.content = name;
    } else {
      renderValues.content = 'New Tab';
    }
  }, []);

  // Add "+" button to tabset header
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleRenderTabSet = useCallback((_node: any, renderValues: any) => {
    renderValues.stickyButtons.push(
      <button
        key="add-tab"
        className="crispy-tab-add-btn"
        title="New tab"
        onClick={() => createTab()}
      >
        +
      </button>,
    );
  }, [createTab]);

  // --- Factory: create per-tab provider cascade ---
  const factory = useCallback((node: TabNode): React.JSX.Element | null => {
    if (node.getComponent() === 'transcript') {
      const tabId = node.getId();
      const sessionId = tabSessionMapRef.current.get(tabId) ?? null;
      const isActive = tabId === activeTabId;

      // Callback for when the tab's session changes (user selects a session within the tab)
      const onSessionChange = (newSessionId: string | null) => {
        tabSessionMapRef.current.set(tabId, newSessionId);
        // Update tab name
        const name = newSessionId ? getTabName(newSessionId, sessionsRef.current) : 'New Tab';
        modelRef.current.doAction(Actions.renameTab(tabId, name));
        // If this is the active tab, update the controller
        if (tabId === activeTabId) {
          controller.setActiveTabSession(newSessionId);
        }
        bump();
      };

      // Read fork config from FlexLayout node config (set during createTab)
      const nodeConfig = node.getConfig();
      const forkConfig = nodeConfig?.forkConfig as ForkConfig | undefined;

      return (
        <TabSessionProvider sessionId={sessionId} onSessionChange={onSessionChange}>
          <TabContent isActive={isActive} forkConfig={forkConfig} />
        </TabSessionProvider>
      );
    }
    return null;
  }, [activeTabId, controller, bump]);

  // --- Tab keyboard shortcuts ---
  const envKind = useEnvironment();
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // VS Code host: Ctrl+Shift+T (new), Ctrl+Shift+W (close), Ctrl+PageUp/Down (cycle)
      // Dev server / Tauri: Alt+N (new), Alt+W (close), Alt+[/] (cycle)
      const isVscode = envKind === 'vscode';

      if (isVscode) {
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
          if (e.key === 'T' || e.key === 't') {
            e.preventDefault();
            createTab();
          } else if (e.key === 'W' || e.key === 'w') {
            e.preventDefault();
            if (activeTabId) closeTab(activeTabId);
          }
        }
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          if (e.key === 'PageDown') {
            e.preventDefault();
            cycleTab(1);
          } else if (e.key === 'PageUp') {
            e.preventDefault();
            cycleTab(-1);
          }
        }
      } else {
        // Dev server / Tauri fallback
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
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [envKind, activeTabId, createTab, closeTab]); // eslint-disable-line react-hooks/exhaustive-deps

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
    return name.length > 30 ? name.slice(0, 30) + '\u2026' : name;
  }
  return sessionId.slice(0, 8) + '\u2026';
}
