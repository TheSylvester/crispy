/**
 * FlexAppLayout — FlexLayout-based layout with per-tab session state
 *
 * Each transcript tab is a self-contained unit with its own session,
 * ControlPanel, StopButton, and approval UI. The tab strip is visible
 * so users can create multiple independent transcript tabs.
 *
 * Architecture:
 *   .crispy-transcript-tab (flex column, fills tab node)
 *     TranscriptHeader      (session dropdown + new-session btn)
 *     .crispy-transcript    (flex: 1, overflow-y: auto — scroll area)
 *     StopButton            (absolute, above ControlPanel)
 *     ControlPanel          (flex: 0 auto — natural height, not fixed)
 *
 * No spacer div needed — flex layout handles the split naturally.
 *
 * @module FlexAppLayout
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import {
  Layout,
  Model,
  Actions,
  DockLocation,
  type TabNode,
  type TabSetNode,
  type BorderNode,
  type IJsonModel,
  type Action as FlexAction,
  type ITabSetRenderValues,
  type ITabRenderValues,
  type Node as FlexNode,
} from 'flexlayout-react';
import { useSession } from './context/SessionContext.js';
import { usePreferences } from './context/PreferencesContext.js';
import { usePlayback } from './hooks/usePlayback.js';
import { PlaybackControls } from './components/PlaybackControls.js';
import { TitleBar } from './components/TitleBar.js';
import { BlocksToolPanel } from './blocks/BlocksToolPanel.js';
import { ActiveTabBlocksProvider } from './blocks/ActiveTabBlocksContext.js';
import { FilePanel } from './components/file-panel/FilePanel.js';
import { FilePanelProvider, useFilePanel } from './context/FilePanelContext.js';
import { FileViewerModal } from './components/file-panel/FileViewerModal.js';
import { TranscriptTab } from './components/TranscriptTab.js';

// ============================================================================
// Constants
// ============================================================================

const INITIAL_TAB_ID = 'transcript';

// ============================================================================
// FlexLayout model definition
// ============================================================================

const FLEX_MODEL: IJsonModel = {
  global: {
    tabEnableClose: false,
    tabSetEnableMaximize: true,
    splitterSize: 4,
    borderSize: 380,
    borderEnableDrop: true,
    tabSetEnableTabStrip: true,
    tabEnableRename: false,
  },
  borders: [
    { type: 'border', location: 'left', size: 300, children: [] },
    {
      type: 'border',
      location: 'right',
      size: 380,
      selected: -1,
      children: [
        {
          type: 'tab',
          id: 'inspector',
          name: 'Inspector',
          component: 'inspector',
          enableClose: false,
        },
        {
          type: 'tab',
          id: 'files',
          name: 'Files',
          component: 'files',
          enableClose: false,
        },
      ],
    },
  ],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        children: [
          {
            type: 'tab',
            id: INITIAL_TAB_ID,
            name: 'Transcript',
            component: 'transcript',
            enableClose: true,
          },
        ],
      },
    ],
  },
};

// ============================================================================
// createTranscriptTab — shared tab creation logic
// ============================================================================

/**
 * Creates a new transcript tab in the FlexLayout model and registers it in
 * the tabSessions map. Returns the new tab's ID.
 *
 * Does NOT set session ID or message ID — that is session lifecycle, not
 * layout creation.
 */
function createTranscriptTab(
  model: Model,
  tabCounterRef: React.MutableRefObject<number>,
  setTabSessions: React.Dispatch<React.SetStateAction<Map<string, string | null>>>,
  setActiveTabId: React.Dispatch<React.SetStateAction<string>>,
  opts?: {
    name?: string;
    targetTabset?: string;
    dockLocation?: DockLocation;
  },
): string {
  const newTabId = `transcript-${Date.now()}-${tabCounterRef.current++}`;
  setTabSessions((prev) => {
    const next = new Map(prev);
    next.set(newTabId, null);
    return next;
  });

  let targetTabset = opts?.targetTabset;
  if (!targetTabset) {
    model.visitNodes((node: FlexNode) => {
      if (!targetTabset && node.getType() === 'tabset') {
        targetTabset = node.getId();
      }
    });
  }
  if (targetTabset) {
    model.doAction(
      Actions.addNode(
        {
          type: 'tab',
          id: newTabId,
          name: opts?.name ?? 'New',
          component: 'transcript',
          enableClose: true,
        },
        targetTabset,
        opts?.dockLocation ?? DockLocation.CENTER,
        -1,
        true,
      ),
    );
  }
  setActiveTabId(newTabId);
  return newTabId;
}

// ============================================================================
// FlexInsertHandlerBridge — registers FilePanelContext insert handler
// Must live inside <FilePanelProvider>. Dispatches a window postMessage
// that the active tab's TranscriptTab picks up.
// ============================================================================

function FlexInsertHandlerBridge(): null {
  const { registerInsertHandler } = useFilePanel();
  useEffect(() => {
    registerInsertHandler((text: string) => {
      window.postMessage({ kind: 'filePanelInsert', content: text }, '*');
    });
  }, [registerInsertHandler]);
  return null;
}

// ============================================================================
// FlexAppLayout — main export
// ============================================================================

export function FlexAppLayout(): React.JSX.Element {
  // --- Session ---
  const { sessions, setSelectedCwd } = useSession();
  const { debugMode } = usePreferences();

  // --- Playback (kept at top level for PlaybackControls overlay) ---
  // Note: usePlayback is called both here and per-tab inside TranscriptTab.
  // They share the same global playback state, which is intentional for debug mode.
  // The per-tab call provides the visibleCount for filtering entries.
  // The top-level call here is just for the PlaybackControls overlay.
  const {
    visibleCount,
    isPlaying,
    speed,
    play,
    pause,
    stepForward,
    stepForward10,
    stepBack,
    reset,
    jumpToEnd,
    setSpeed,
  } = usePlayback(0); // 0 entries since we don't use the count here

  // --- Per-tab session state ---
  // Maps tab node IDs → selected session IDs (null = no session / welcome)
  const [tabSessions, setTabSessions] = useState<Map<string, string | null>>(
    () => new Map([[INITIAL_TAB_ID, null]]),
  );

  // Track which tab is currently active
  const [activeTabId, setActiveTabId] = useState<string>(INITIAL_TAB_ID);

  // --- FlexLayout model ---
  const [model] = useState(() => Model.fromJson(FLEX_MODEL));

  // Tab counter for unique IDs
  const tabCounterRef = useRef(1);

  // --- onAction handler: track active tab, handle tab close ---
  const handleAction = useCallback(
    (action: FlexAction): FlexAction | undefined => {
      if (action.type === Actions.SELECT_TAB) {
        const tabId = action.data?.tabNode as string | undefined;
        if (tabId && tabId !== 'inspector' && tabId !== 'files') {
          setActiveTabId(tabId);
        }
      }
      // When user clicks inside a different tabset's content area (after
      // splitting), FlexLayout fires SET_ACTIVE_TABSET instead of SELECT_TAB.
      // Derive the selected tab from the tabset so activeTabId stays current.
      if (action.type === Actions.SET_ACTIVE_TABSET) {
        const tabsetId = action.data?.tabsetNode as string | undefined;
        if (tabsetId) {
          const tabsetNode = model.getNodeById(tabsetId);
          if (tabsetNode && 'getSelectedNode' in tabsetNode) {
            const selectedNode = (tabsetNode as TabSetNode).getSelectedNode();
            const selectedId = selectedNode?.getId();
            if (selectedId && selectedId !== 'inspector' && selectedId !== 'files') {
              setActiveTabId(selectedId);
            }
          }
        }
      }
      if (action.type === Actions.DELETE_TAB) {
        const tabId = action.data?.node as string | undefined;
        if (tabId) {
          setTabSessions((prev) => {
            const next = new Map(prev);
            next.delete(tabId);

            // If this was the last transcript tab, auto-create a fresh one
            // (browser-style: always keep at least one tab open).
            if (next.size === 0) {
              // Schedule the FlexLayout addNode after the current action completes,
              // since we can't mutate the model mid-action.
              queueMicrotask(() => {
                createTranscriptTab(
                  model,
                  tabCounterRef,
                  setTabSessions,
                  setActiveTabId,
                );
              });
            }

            return next;
          });
        }
      }
      return action;
    },
    [model],
  );

  // --- onRenderTabSet: add "+" button for new transcript tabs ---
  const handleRenderTabSet = useCallback(
    (node: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
      // Only add "+" button to main tabsets, not border nodes
      if ('getLocation' in node && typeof (node as BorderNode).getLocation === 'function') {
        // BorderNode — skip
        return;
      }

      renderValues.stickyButtons.push(
        <button
          key="add-tab"
          className="crispy-tab-add-btn"
          onClick={() => {
            createTranscriptTab(
              model,
              tabCounterRef,
              setTabSessions,
              setActiveTabId,
              {
                targetTabset: node.getId(),
                dockLocation: DockLocation.RIGHT,
              },
            );
          }}
          title="New tab"
          aria-label="New transcript tab"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M6 2V10M2 6H10" />
          </svg>
        </button>,
      );
    },
    [model],
  );

  // --- onRenderTab: dynamic tab names from session labels ---
  const MAX_TAB_LABEL = 28;
  const handleRenderTab = useCallback(
    (node: TabNode, renderValues: ITabRenderValues) => {
      // Only customise transcript tabs, leave border tabs (Inspector, Files) alone
      if (node.getComponent() !== 'transcript') return;

      const tabId = node.getId();
      const sessionId = tabSessions.get(tabId);
      if (!sessionId) {
        // No session loaded → show "New"
        renderValues.content = 'New';
        return;
      }
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (!session?.label) {
        renderValues.content = 'New';
        return;
      }
      const label = session.label.length > MAX_TAB_LABEL
        ? session.label.slice(0, MAX_TAB_LABEL) + '\u2026'
        : session.label;
      renderValues.content = label;
    },
    [tabSessions, sessions],
  );

  // Stable ref to activeTabId — used by forkToNewTab and handleTabSessionChange
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // --- forkToNewTab: intercept browser fork and open in a FlexLayout tab ---
  // The WebSocket transport dispatches a 'forkToNewTab' postMessage instead of
  // window.open(). We create a new tab in the active tabset and deliver the
  // fork config to its ControlPanel via the existing forkConfig message flow.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.data?.kind !== 'forkToNewTab') return;
      const { fromSessionId, atMessageId, initialPrompt, model: forkModel, agencyMode, bypassEnabled, chromeEnabled } = ev.data;

      // 1. Create a new FlexLayout tab (same pattern as the "+" button)
      // Find the active tab's parent tabset so the fork opens beside it
      const activeNode = model.getNodeById(activeTabIdRef.current);
      const parentTabset = activeNode?.getParent()?.getId();

      const newTabId = createTranscriptTab(
        model,
        tabCounterRef,
        setTabSessions,
        setActiveTabId,
        {
          name: 'Fork',
          targetTabset: parentTabset,
          dockLocation: DockLocation.RIGHT,
        },
      );

      // 2. Deliver forkConfig to the new tab's ControlPanel via postMessage.
      //    Retry to handle React mount timing (listener is idempotent).
      const forkConfig = {
        kind: 'forkConfig',
        targetTabId: newTabId,
        fromSessionId,
        atMessageId,
        initialPrompt,
        model: forkModel,
        agencyMode,
        bypassEnabled,
        chromeEnabled,
      };
      const delays = [100, 400, 1200];
      for (const delay of delays) {
        setTimeout(() => window.postMessage(forkConfig, '*'), delay);
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [model]); // model is stable (useState initializer)

  // --- Per-tab session change handler ---
  const handleTabSessionChange = useCallback(
    (tabId: string, newSessionId: string | null) => {
      setTabSessions((prev) => {
        const next = new Map(prev);
        next.set(tabId, newSessionId);
        return next;
      });
      // If this is the active tab, update CWD to the new session's project
      if (tabId === activeTabIdRef.current && newSessionId) {
        const session = sessions.find((s) => s.sessionId === newSessionId);
        if (session?.projectSlug) {
          setSelectedCwd(session.projectSlug);
        }
      }
    },
    [sessions, setSelectedCwd],
  );

  // --- Activate a tab (make it the active tab, sync CWD) ---
  const handleActivateTab = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      // Sync CWD to the activated tab's session's project
      const tabSession = tabSessions.get(tabId) ?? null;
      if (tabSession) {
        const session = sessions.find((s) => s.sessionId === tabSession);
        if (session?.projectSlug) {
          setSelectedCwd(session.projectSlug);
        }
      }
    },
    [tabSessions, sessions, setSelectedCwd],
  );

  // --- Factory ---
  const factory = useCallback(
    (node: TabNode) => {
      switch (node.getComponent()) {
        case 'transcript': {
          const nodeId = node.getId();
          return (
            <TranscriptTab
              tabId={nodeId}
              isActiveTab={nodeId === activeTabId}
              sessionId={tabSessions.get(nodeId) ?? null}
              onSessionIdChange={(id) => handleTabSessionChange(nodeId, id)}
              onActivateTab={() => handleActivateTab(nodeId)}
            />
          );
        }
        case 'inspector':
          return <BlocksToolPanel />;
        case 'files':
          return <FilePanel />;
        default:
          return (
            <div>Unknown component: {node.getComponent()}</div>
          );
      }
    },
    [activeTabId, tabSessions, handleTabSessionChange, handleActivateTab],
  );

  // --- Render ---
  return (
    <div
      className="crispy-layout crispy-layout--flex"
    >
      <TitleBar />
      <FilePanelProvider>
        <FlexInsertHandlerBridge />

        <ActiveTabBlocksProvider>
          <main
            className="crispy-flex-area"
          >
            <Layout
              model={model}
              factory={factory}
              onAction={handleAction}
              onRenderTabSet={handleRenderTabSet}
              onRenderTab={handleRenderTab}
            />
          </main>
          <FileViewerModal />
        </ActiveTabBlocksProvider>

        {debugMode && (
          <PlaybackControls
            visibleCount={visibleCount}
            totalEntries={0}
            isPlaying={isPlaying}
            speed={speed}
            onPlay={play}
            onPause={pause}
            onStepForward={stepForward}
            onStepForward10={stepForward10}
            onStepBack={stepBack}
            onReset={reset}
            onJumpToEnd={jumpToEnd}
            onSpeedChange={setSpeed}
          />
        )}
      </FilePanelProvider>
    </div>
  );
}
