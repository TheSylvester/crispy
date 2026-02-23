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

import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
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
} from 'flexlayout-react';
import { useSession } from './context/SessionContext.js';
import { usePreferences } from './context/PreferencesContext.js';
import { useTranscript } from './hooks/useTranscript.js';
import { usePlayback } from './hooks/usePlayback.js';
import { useAutoScroll } from './hooks/useAutoScroll.js';
import { shouldRenderEntry } from './utils/entry-filters.js';
import { EntryRenderer } from './renderers/EntryRenderer.js';
import { PlaybackControls } from './components/PlaybackControls.js';
import { ForkProvider } from './context/ForkContext.js';
import { ControlPanel } from './components/control-panel/index.js';
import { RenderLocationProvider } from './context/RenderLocationContext.js';
import { mapPermissionModeToAgency } from './components/control-panel/types.js';
import type { AgencyMode } from './components/control-panel/types.js';
import { StopButton } from './components/control-panel/StopButton.js';
import { ThinkingIndicator } from './components/ThinkingIndicator.js';
import { ApprovalContent } from './components/approval/index.js';
import { useApprovalRequest } from './hooks/useApprovalRequest.js';
import { constructExitPlanHandoffPrompt } from './components/approval/approval-utils.js';
import { useTransport } from './context/TransportContext.js';
import { useSessionStatus } from './hooks/useSessionStatus.js';
import type { ApprovalExtra } from './components/approval/types.js';
import type { TranscriptEntry } from '../core/transcript.js';
import { WelcomePage } from './components/WelcomePage.js';
import { isPerfMode, PerfProfiler } from './perf/index.js';
import { PerfStore } from './perf/profiler.js';
import { BlocksToolRegistryProvider } from './blocks/BlocksToolRegistryContext.js';
import { BlocksVisibilityProvider } from './blocks/BlocksVisibilityContext.js';
import { PanelStateProvider } from './blocks/PanelStateContext.js';
import { BlocksToolPanel } from './blocks/BlocksToolPanel.js';
import { SessionSelector } from './components/SessionSelector.js';
import { TitleBar } from './components/TitleBar.js';
import { FilePanel } from './components/file-panel/FilePanel.js';
import { FilePanelProvider } from './context/FilePanelContext.js';
import { useFilePanel } from './context/FilePanelContext.js';
import { FileViewerModal } from './components/file-panel/FileViewerModal.js';

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
            enableClose: false,
          },
        ],
      },
    ],
  },
};

// ============================================================================
// FlexTranscriptContent — self-contained transcript tab with embedded
// ControlPanel, StopButton, and approval UI
// ============================================================================

interface FlexTranscriptContentProps {
  tabId: string;
  isActiveTab: boolean;
  /** Per-tab session ID (null = no session / welcome). */
  sessionId: string | null;
  /** Update this tab's session ID in the parent tabSessions map. */
  onSessionIdChange: (id: string | null) => void;
  /** Ensure this tab becomes the active tab (syncs global session state). */
  onActivateTab: () => void;
}

/** SVG chevron — points down, rotates 180° when sidebar is open */
function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      className={`crispy-transcript-header__chevron${open ? ' crispy-transcript-header__chevron--open' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3,4.5 6,7.5 9,4.5" />
    </svg>
  );
}

/** Plus icon for the New button */
function PlusIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M6 2V10M2 6H10" />
    </svg>
  );
}

/**
 * TranscriptHeader — session dropdown toggle + new-session button.
 * Lives inside the transcript tab, above the scroll area.
 * "New" clears session in the current tab (not global).
 *
 * The sidebar toggle is provided by the parent (FlexTranscriptContent)
 * so it can activate the owning tab before opening the shared sidebar.
 */
function TranscriptHeader({
  onNewSession,
  onToggleSidebar,
  sessionId: headerSessionId,
}: {
  onNewSession: () => void;
  /** Toggle sidebar, ensuring this tab is activated first. */
  onToggleSidebar: () => void;
  /** Per-tab session ID for label lookup. */
  sessionId: string | null;
}): React.JSX.Element {
  const { sessions } = useSession();
  const { sidebarCollapsed } = usePreferences();

  const sessionLabel =
    sessions.find((s) => s.sessionId === headerSessionId)?.label ?? 'No session';

  return (
    <div className="crispy-transcript-header">
      <button
        className="crispy-transcript-header__btn crispy-transcript-header__session-btn"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? 'Open sessions' : 'Close sessions'}
        title="Toggle session list"
      >
        <span className="crispy-transcript-header__label">{sessionLabel}</span>
        <Chevron open={!sidebarCollapsed} />
      </button>
      <button
        className="crispy-transcript-header__btn crispy-transcript-header__new-btn"
        onClick={onNewSession}
        title="New session"
      >
        <PlusIcon />
        <span>New</span>
      </button>
    </div>
  );
}

function FlexTranscriptContent({
  tabId,
  isActiveTab,
  sessionId: tabSessionId,
  onSessionIdChange,
  onActivateTab,
}: FlexTranscriptContentProps): React.JSX.Element {
  // --- Session & transport (per-tab) ---
  // Use per-tab session ID from props, NOT the global selectedSessionId.
  // This ensures each FlexLayout tab can independently load a different session.
  const transport = useTransport();
  const {
    entries,
    isLoading,
    error,
    addOptimisticEntry,
    setForkHistory,
  } = useTranscript(tabSessionId);
  const { renderMode, sidebarCollapsed, setSidebarCollapsed } = usePreferences();
  const {
    approvalRequest,
    resolve: resolveApproval,
  } = useApprovalRequest(tabSessionId);
  const [bypassEnabled, setBypassEnabled] = useState(false);
  const [prefillInput, setPrefillInput] = useState<{
    text: string;
    autoSend?: boolean;
  } | null>(null);
  const [pendingAgencyMode, setPendingAgencyMode] = useState<{
    agencyMode: AgencyMode;
    bypassEnabled: boolean;
  } | null>(null);

  // --- Playback ---
  const {
    visibleCount,
  } = usePlayback(entries.length);

  // --- scrollRef ---
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const setTranscriptRef = useCallback((el: HTMLDivElement | null) => {
    transcriptScrollRef.current = el;
  }, []);

  // --- ControlPanel height → CSS custom property for scroll padding ---
  // Ref callback: attaches a ResizeObserver each time the CP element mounts,
  // and disconnects when it unmounts or swaps (welcome → main view).
  const cpObserverRef = useRef<ResizeObserver | null>(null);
  const cpElRef = useCallback((el: HTMLDivElement | null) => {
    // Tear down previous observer
    if (cpObserverRef.current) {
      cpObserverRef.current.disconnect();
      cpObserverRef.current = null;
    }
    if (!el) return;
    const tab = el.closest('.crispy-transcript-tab') as HTMLElement | null;
    if (!tab) return;
    const observer = new ResizeObserver(([entry]) => {
      tab.style.setProperty('--cp-height', `${entry.borderBoxSize[0].blockSize}px`);
    });
    observer.observe(el);
    cpObserverRef.current = observer;
  }, []);

  // --- Fork history ---
  const [hasForkHistory, setHasForkHistory] = useState(false);

  const handleForkHistoryLoaded = useCallback(
    (forkEntries: TranscriptEntry[]) => {
      setForkHistory(forkEntries);
      setHasForkHistory(true);
    },
    [setForkHistory],
  );

  useEffect(() => {
    if (tabSessionId) {
      setHasForkHistory(false);
    }
  }, [tabSessionId]);

  // --- Entry filtering ---
  const visibleEntries = useMemo(
    () => entries.slice(0, visibleCount),
    [entries, visibleCount],
  );
  const filterFn = shouldRenderEntry;
  const filteredEntries = useMemo(
    () => visibleEntries.filter(filterFn),
    [visibleEntries, filterFn],
  );

  // Perf profiler stats
  if (isPerfMode) {
    let blockCount = 0;
    for (const entry of filteredEntries) {
      const content = entry.message?.content;
      blockCount += Array.isArray(content)
        ? content.length
        : content
          ? 1
          : 0;
    }
    PerfStore.recordEntryStats(
      entries.length,
      filteredEntries.length,
      blockCount,
    );
  }

  // --- Fork targets ---
  const forkTargets = useMemo(() => {
    const targets = new Map<string, string>();
    for (let i = 0; i < filteredEntries.length; i++) {
      const entry = filteredEntries[i];
      if (entry.type !== 'user' || !entry.uuid) continue;
      let found = false;
      for (let j = i - 1; j >= 0; j--) {
        if (
          filteredEntries[j].type === 'assistant' &&
          filteredEntries[j].uuid
        ) {
          targets.set(entry.uuid, filteredEntries[j].uuid!);
          found = true;
          break;
        }
      }
      if (!found) {
        targets.set(entry.uuid, '');
      }
    }
    return targets;
  }, [filteredEntries]);

  // --- Channel state ---
  const { channelState } = useSessionStatus(tabSessionId);

  // --- Auto-scroll ---
  const { parked, isAtTop, scrollToBottom, scrollToTop, pinToBottom } =
    useAutoScroll({
      sessionId: tabSessionId,
      scrollRef: transcriptScrollRef,
      remount: hasForkHistory,
    });

  // --- Fork preview glow ---
  const handleForkHoverChange = useCallback((hovering: boolean) => {
    if (hovering) {
      const msgs = document.querySelectorAll('.message.assistant');
      const last = msgs[msgs.length - 1];
      if (last) last.classList.add('crispy-fork-preview');
    } else {
      document
        .querySelectorAll('.message.crispy-fork-preview')
        .forEach((el) => {
          el.classList.remove('crispy-fork-preview');
        });
    }
  }, []);

  const handleForkPreviewHover = useCallback(
    (targetMessageId: string, hovering: boolean) => {
      if (hovering) {
        const el = document.querySelector(
          `.message[data-uuid="${targetMessageId}"]`,
        );
        if (el) el.classList.add('crispy-fork-preview');
      } else {
        document
          .querySelectorAll('.message.crispy-fork-preview')
          .forEach((el) => el.classList.remove('crispy-fork-preview'));
      }
    },
    [],
  );

  // --- Per-message fork handler ---
  const forkHandlerRef = useRef<((atMessageId: string) => void) | null>(null);
  const handleRegisterForkHandler = useCallback(
    (handler: (atMessageId: string) => void) => {
      forkHandlerRef.current = handler;
    },
    [],
  );
  const handlePerMessageFork = useCallback((atMessageId: string) => {
    forkHandlerRef.current?.(atMessageId);
  }, []);

  // --- Per-message rewind handler ---
  const rewindHandlerRef = useRef<((atMessageId: string) => void) | null>(
    null,
  );
  const handleRegisterRewindHandler = useCallback(
    (handler: (atMessageId: string) => void) => {
      rewindHandlerRef.current = handler;
    },
    [],
  );
  const forkTargetsRef = useRef(forkTargets);
  forkTargetsRef.current = forkTargets;
  const filteredEntriesRef = useRef(filteredEntries);
  filteredEntriesRef.current = filteredEntries;

  const handlePerMessageRewind = useCallback(
    (atMessageId: string) => {
      const extractUserText = (): string => {
        for (const [userUUID, assistantUUID] of forkTargetsRef.current.entries()) {
          if (assistantUUID === atMessageId) {
            const userEntry = filteredEntriesRef.current.find(
              (e) => e.uuid === userUUID,
            );
            if (userEntry?.message?.content) {
              const content = userEntry.message.content;
              return Array.isArray(content)
                ? content
                    .filter(
                      (b): b is { type: 'text'; text: string } =>
                        b.type === 'text',
                    )
                    .map((b) => b.text)
                    .join('\n')
                : typeof content === 'string'
                  ? content
                  : '';
            }
            break;
          }
        }
        return '';
      };

      if (!atMessageId) {
        const text = extractUserText();
        onSessionIdChange(null);
        if (text) setPrefillInput({ text });
        return;
      }

      rewindHandlerRef.current?.(atMessageId);
      const text = extractUserText();
      if (text) setPrefillInput({ text });
    },
    [setPrefillInput, onSessionIdChange],
  );

  // --- Approval resolve with ExitPlanMode orchestration ---
  const handleApprovalResolve = useCallback(
    async (
      optionId: string,
      extra?: ApprovalExtra & { clearContext?: boolean; planContent?: string },
    ) => {
      const { clearContext, planContent, ...transportExtra } = extra ?? {};

      if (clearContext && tabSessionId) {
        const handoffPrompt = constructExitPlanHandoffPrompt(
          planContent,
          tabSessionId,
        );

        await resolveApproval(
          optionId,
          Object.keys(transportExtra).length ? transportExtra : undefined,
        );

        try {
          await transport.close(tabSessionId);
        } catch (err) {
          console.warn('[FlexTranscriptContent] close session failed:', err);
        }

        onSessionIdChange(null);

        const targetMode = (
          transportExtra.updatedPermissions?.[0] as { mode?: string }
        )?.mode;
        if (targetMode) {
          const agencyMode = mapPermissionModeToAgency(targetMode);
          if (agencyMode) {
            setPendingAgencyMode({
              agencyMode,
              bypassEnabled: targetMode === 'bypassPermissions',
            });
          }
        }

        setPrefillInput({ text: handoffPrompt, autoSend: true });
        return;
      }

      await resolveApproval(
        optionId,
        Object.keys(transportExtra).length ? transportExtra : undefined,
      );
    },
    [resolveApproval, tabSessionId, transport, onSessionIdChange],
  );

  // --- postMessage listeners (active tab only) ---
  // Handles "Execute in Crispy" and file panel insert messages
  useEffect(() => {
    if (!isActiveTab) return;
    const handler = (ev: MessageEvent) => {
      if (ev.data?.kind === 'executeInCrispy' && ev.data.content) {
        onSessionIdChange(null);
        setPrefillInput({ text: ev.data.content });
      }
      if (ev.data?.kind === 'filePanelInsert' && ev.data.content) {
        setPrefillInput({ text: ev.data.content });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onSessionIdChange, isActiveTab]);

  // --- Prefill / agency consumed callbacks ---
  const handlePrefillConsumed = useCallback(() => {
    setPrefillInput(null);
  }, []);

  const handlePendingAgencyModeConsumed = useCallback(
    () => setPendingAgencyMode(null),
    [],
  );

  // --- "New session" in current tab ---
  const handleNewSession = useCallback(() => {
    onSessionIdChange(null);
  }, [onSessionIdChange]);

  // --- Toggle sidebar, activating this tab first ---
  // The sidebar is a single shared overlay. Activating the tab ensures the
  // global selectedSessionId syncs to *this* tab's session before the sidebar
  // opens, so session selection lands in the correct tab.
  const handleToggleSidebar = useCallback(() => {
    onActivateTab();
    setSidebarCollapsed(!sidebarCollapsed);
  }, [onActivateTab, sidebarCollapsed, setSidebarCollapsed]);

  // No session and no fork history → welcome page (with ControlPanel still)
  if (!tabSessionId && !hasForkHistory) {
    return (
      <div className="crispy-transcript-tab" data-tab-id={tabId}>
        <TranscriptHeader onNewSession={handleNewSession} onToggleSidebar={handleToggleSidebar} sessionId={tabSessionId} />
        <WelcomePage loading={isLoading} />
        <StopButton sessionId={tabSessionId} />
        <ControlPanel
          ref={cpElRef}
          sessionId={tabSessionId}
          onSessionIdChange={onSessionIdChange}
          isActiveTab={isActiveTab}
          onForkHoverChange={handleForkHoverChange}
          onRegisterForkHandler={handleRegisterForkHandler}
          onRegisterRewindHandler={handleRegisterRewindHandler}
          onScrollToBottom={pinToBottom}
          entries={entries}
          onBypassChange={setBypassEnabled}
          prefillInput={prefillInput}
          onPrefillConsumed={handlePrefillConsumed}
          onForkHistoryLoaded={handleForkHistoryLoaded}
          pendingAgencyMode={pendingAgencyMode}
          onPendingAgencyModeConsumed={handlePendingAgencyModeConsumed}
          onOptimisticEntry={addOptimisticEntry}
        >
          {approvalRequest && (
            <ApprovalContent
              request={approvalRequest}
              onResolve={handleApprovalResolve}
              bypassEnabled={bypassEnabled}
            />
          )}
        </ControlPanel>
      </div>
    );
  }

  if (error) {
    return (
      <div className="crispy-transcript-tab" data-tab-id={tabId}>
        <TranscriptHeader onNewSession={handleNewSession} onToggleSidebar={handleToggleSidebar} sessionId={tabSessionId} />
        <div className="crispy-error">{error}</div>
      </div>
    );
  }

  return (
    <RenderLocationProvider location="transcript">
      <ForkProvider
        onFork={handlePerMessageFork}
        onRewind={handlePerMessageRewind}
        onForkPreviewHover={handleForkPreviewHover}
        isStreaming={channelState === 'streaming'}
        forkTargets={forkTargets}
      >
        <div className="crispy-transcript-tab" data-tab-id={tabId}>
          <TranscriptHeader onNewSession={handleNewSession} onToggleSidebar={handleToggleSidebar} sessionId={tabSessionId} />
          <div
            className="crispy-transcript"
            ref={setTranscriptRef}
            data-render-mode={renderMode}
          >
            <div className="crispy-transcript-content">
              {isLoading ? (
                <div className="crispy-loading">Loading transcript...</div>
              ) : (
                <PerfProfiler id="TranscriptList">
                  {filteredEntries.map((entry, i) => (
                    <EntryRenderer
                      key={entry.uuid ?? `entry-${i}`}
                      entry={entry}
                      mode={renderMode}
                      forkTargetId={
                        entry.uuid ? forkTargets.get(entry.uuid) : undefined
                      }
                    />
                  ))}
                </PerfProfiler>
              )}
              <ThinkingIndicator sessionId={tabSessionId} />
            </div>
          </div>
          <button
            className={`crispy-scroll-nav crispy-scroll-to-top ${isAtTop ? 'crispy-scroll-to-top--hidden' : ''}`}
            onClick={scrollToTop}
            aria-label="Scroll to top"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            >
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            className={`crispy-scroll-nav crispy-scroll-to-bottom ${parked ? 'crispy-scroll-to-bottom--hidden' : ''}`}
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <StopButton sessionId={tabSessionId} />
          <ControlPanel
            ref={cpElRef}
            sessionId={tabSessionId}
            onSessionIdChange={onSessionIdChange}
            isActiveTab={isActiveTab}
            onForkHoverChange={handleForkHoverChange}
            onRegisterForkHandler={handleRegisterForkHandler}
            onRegisterRewindHandler={handleRegisterRewindHandler}
            onScrollToBottom={pinToBottom}
            entries={entries}
            onBypassChange={setBypassEnabled}
            prefillInput={prefillInput}
            onPrefillConsumed={handlePrefillConsumed}
            onForkHistoryLoaded={handleForkHistoryLoaded}
            pendingAgencyMode={pendingAgencyMode}
            onPendingAgencyModeConsumed={handlePendingAgencyModeConsumed}
            onOptimisticEntry={addOptimisticEntry}
          >
            {approvalRequest && (
              <ApprovalContent
                request={approvalRequest}
                onResolve={handleApprovalResolve}
                bypassEnabled={bypassEnabled}
              />
            )}
          </ControlPanel>
        </div>
      </ForkProvider>
    </RenderLocationProvider>
  );
}

// ============================================================================
// FlexInsertHandlerBridge — registers FilePanelContext insert handler
// Must live inside <FilePanelProvider>. Dispatches a window postMessage
// that the active tab's FlexTranscriptContent picks up.
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
  const { selectedSessionId, setSelectedSessionId } = useSession();
  const {
    entries,
  } = useTranscript(selectedSessionId);
  const { sidebarCollapsed, setSidebarCollapsed, debugMode } =
    usePreferences();

  // --- Playback (kept at top level for PlaybackControls overlay) ---
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
  } = usePlayback(entries.length);

  // --- Entry filtering (for BlocksToolRegistryProvider) ---
  const visibleEntries = useMemo(
    () => entries.slice(0, visibleCount),
    [entries, visibleCount],
  );

  // --- Channel state (for data-streaming attribute on layout root) ---
  const { channelState } = useSessionStatus(selectedSessionId);
  const isStreaming = channelState === 'streaming';

  // --- Per-tab session state ---
  // Maps tab node IDs → selected session IDs (null = no session / welcome)
  const [tabSessions, setTabSessions] = useState<Map<string, string | null>>(
    () => new Map([[INITIAL_TAB_ID, selectedSessionId]]),
  );

  // Track which tab is currently active
  const [activeTabId, setActiveTabId] = useState<string>(INITIAL_TAB_ID);

  // Sync global selectedSessionId to the active tab's session
  // When sidebar selection changes the global session, update active tab
  const prevGlobalSessionRef = useRef(selectedSessionId);
  useEffect(() => {
    if (selectedSessionId !== prevGlobalSessionRef.current) {
      prevGlobalSessionRef.current = selectedSessionId;
      setTabSessions((prev) => {
        const next = new Map(prev);
        next.set(activeTabId, selectedSessionId);
        return next;
      });
    }
  }, [selectedSessionId, activeTabId]);

  // When active tab changes, sync global session to that tab's session
  useEffect(() => {
    const tabSession = tabSessions.get(activeTabId);
    if (tabSession !== undefined && tabSession !== selectedSessionId) {
      prevGlobalSessionRef.current = tabSession;
      setSelectedSessionId(tabSession);
    }
  }, [activeTabId, tabSessions, selectedSessionId, setSelectedSessionId]);

  // --- scrollRef for BlocksVisibilityProvider ---
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  // --- Sidebar ---
  const closeSidebar = useCallback(() => {
    setSidebarCollapsed(true);
  }, [setSidebarCollapsed]);

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
            const newTabId = `transcript-${Date.now()}-${tabCounterRef.current++}`;
            // Initialize new tab's session to null (WelcomePage)
            setTabSessions((prev) => {
              const next = new Map(prev);
              next.set(newTabId, null);
              return next;
            });
            model.doAction(
              Actions.addNode(
                {
                  type: 'tab',
                  id: newTabId,
                  name: 'New',
                  component: 'transcript',
                  enableClose: true,
                },
                node.getId(),
                DockLocation.RIGHT,
                -1,
                true,
              ),
            );
            // model.doAction() bypasses onAction, so activeTabId won't
            // be updated by handleAction. Sync it manually.
            setActiveTabId(newTabId);
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

  // --- Per-tab session change handler ---
  // Stable ref to activeTabId so the callback doesn't depend on it directly
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const handleTabSessionChange = useCallback(
    (tabId: string, newSessionId: string | null) => {
      setTabSessions((prev) => {
        const next = new Map(prev);
        next.set(tabId, newSessionId);
        return next;
      });
      // If this is the active tab, also sync the global selectedSessionId
      if (tabId === activeTabIdRef.current) {
        prevGlobalSessionRef.current = newSessionId;
        setSelectedSessionId(newSessionId);
      }
    },
    [setSelectedSessionId],
  );

  // --- Activate a tab (make it the active tab, sync global session) ---
  const handleActivateTab = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      // Eagerly sync global session so the sidebar shows the right session
      // selected before the effect fires on the next render.
      const tabSession = tabSessions.get(tabId) ?? null;
      if (tabSession !== selectedSessionId) {
        prevGlobalSessionRef.current = tabSession;
        setSelectedSessionId(tabSession);
      }
    },
    [tabSessions, selectedSessionId, setSelectedSessionId],
  );

  // --- Factory ---
  const factory = useCallback(
    (node: TabNode) => {
      switch (node.getComponent()) {
        case 'transcript': {
          const nodeId = node.getId();
          return (
            <FlexTranscriptContent
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
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'open'}
      data-streaming={isStreaming || undefined}
    >
      <TitleBar />
      <FilePanelProvider>
        <FlexInsertHandlerBridge />
        <aside className="crispy-sidebar">
          <div className="crispy-sidebar__header">Sessions</div>
          <SessionSelector />
        </aside>

        {!sidebarCollapsed && (
          <div
            className="crispy-sidebar-backdrop"
            onClick={closeSidebar}
            aria-hidden="true"
          />
        )}

        <BlocksToolRegistryProvider
          entries={visibleEntries}
          sessionId={selectedSessionId}
        >
          <PanelStateProvider>
            <BlocksVisibilityProvider
              scrollRef={transcriptScrollRef}
            >
              <main
                className="crispy-flex-area"
                data-streaming={isStreaming || undefined}
              >
                <Layout
                  model={model}
                  factory={factory}
                  onAction={handleAction}
                  onRenderTabSet={handleRenderTabSet}
                />
              </main>
              <FileViewerModal />
            </BlocksVisibilityProvider>
          </PanelStateProvider>
        </BlocksToolRegistryProvider>

        {debugMode && (
          <PlaybackControls
            visibleCount={visibleCount}
            totalEntries={entries.length}
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
