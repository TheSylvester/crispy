/**
 * FlexAppLayout — FlexLayout-based layout replacing AppLayout
 *
 * Wraps flexlayout-react's Layout component with the same provider cascade
 * and hook wiring that TranscriptViewer provided. Key changes from AppLayout:
 *
 *   - Inspector (BlocksToolPanel) and Files (FilePanel) live as FlexLayout
 *     border tabs (dockable left/right), not position:fixed panels
 *   - Transcript content is a FlexLayout tab node in the main area
 *   - Providers (BlocksToolRegistryProvider, PanelStateProvider,
 *     BlocksVisibilityProvider) are lifted above <Layout> so both transcript
 *     and border tabs share context
 *   - ConnectorLines removed (hover/click linking deferred)
 *
 * SessionSelector, ControlPanel, TitleBar, StopButton, and PlaybackControls
 * remain OUTSIDE FlexLayout as fixed overlays, same as before.
 *
 * @module FlexAppLayout
 */

import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { Layout, Model, type TabNode, type IJsonModel } from 'flexlayout-react';
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
import type { RenderMode } from './types.js';
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
// FlexLayout model definition
// ============================================================================

const FLEX_MODEL: IJsonModel = {
  global: {
    tabEnableClose: false,
    tabSetEnableMaximize: true,
    splitterSize: 4,
    borderSize: 380,
    borderEnableDrop: true,
    tabSetEnableTabStrip: false,
    tabEnableRename: false,
  },
  borders: [
    { type: 'border', location: 'left', size: 300, children: [] },
    {
      type: 'border',
      location: 'right',
      size: 380,
      selected: 0,
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
            id: 'transcript',
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
// FlexTranscriptContent — inline component for the transcript tab node
// ============================================================================

interface FlexTranscriptContentProps {
  filteredEntries: TranscriptEntry[];
  forkTargets: Map<string, string>;
  renderMode: RenderMode;
  isLoading: boolean;
  channelState: string | null;
  hasForkHistory: boolean;
  error: string | null;
  selectedSessionId: string | null;
  scrollRef: (el: HTMLDivElement | null) => void;
  parked: boolean;
  isAtTop: boolean;
  scrollToBottom: () => void;
  scrollToTop: () => void;
  onPerMessageFork: (atMessageId: string) => void;
  onPerMessageRewind: (atMessageId: string) => void;
  onForkPreviewHover: (targetMessageId: string, hovering: boolean) => void;
}

function FlexTranscriptContent({
  filteredEntries,
  forkTargets,
  renderMode,
  isLoading,
  channelState,
  hasForkHistory,
  error,
  selectedSessionId,
  scrollRef,
  parked,
  isAtTop,
  scrollToBottom,
  scrollToTop,
  onPerMessageFork,
  onPerMessageRewind,
  onForkPreviewHover,
}: FlexTranscriptContentProps): React.JSX.Element {
  // No session and no fork history → welcome page
  if (!selectedSessionId && !hasForkHistory) {
    return <WelcomePage loading={isLoading} />;
  }

  if (error) {
    return <div className="crispy-error">{error}</div>;
  }

  return (
    <RenderLocationProvider location="transcript">
      <ForkProvider
        onFork={onPerMessageFork}
        onRewind={onPerMessageRewind}
        onForkPreviewHover={onForkPreviewHover}
        isStreaming={channelState === 'streaming'}
        forkTargets={forkTargets}
      >
        <div
          className="crispy-transcript"
          ref={scrollRef}
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
            <ThinkingIndicator />
            <div className="crispy-transcript-spacer" />
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
      </ForkProvider>
    </RenderLocationProvider>
  );
}

// ============================================================================
// FlexInsertHandlerBridge — registers FilePanelContext insert handler
// Must live inside <FilePanelProvider>. Bridges the insert callback to
// FlexAppLayout's setPrefillInput without requiring useFilePanel at the
// top level (which would be outside the provider).
// ============================================================================

function FlexInsertHandlerBridge({
  setPrefillInput,
}: {
  setPrefillInput: (v: { text: string }) => void;
}): null {
  const { registerInsertHandler } = useFilePanel();
  useEffect(() => {
    registerInsertHandler((text: string) => {
      setPrefillInput({ text });
    });
  }, [registerInsertHandler, setPrefillInput]);
  return null;
}

// ============================================================================
// FlexAppLayout — main export
// ============================================================================

export function FlexAppLayout(): React.JSX.Element {
  // --- Session & transport ---
  const { selectedSessionId, setSelectedSessionId } = useSession();
  const transport = useTransport();
  const {
    entries,
    isLoading,
    error,
    addOptimisticEntry,
    setForkHistory,
  } = useTranscript(selectedSessionId);
  const { renderMode, sidebarCollapsed, setSidebarCollapsed, debugMode } =
    usePreferences();
  const {
    approvalRequest,
    resolve: resolveApproval,
  } = useApprovalRequest(selectedSessionId);
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

  // --- Refs ---
  const controlPanelRef = useRef<HTMLDivElement>(null);
  const stopButtonRef = useRef<HTMLDivElement>(null);

  // scrollRef for BlocksVisibilityProvider — stable callback ref.
  // Unlike the old AppLayout, we do NOT use a mount-key pattern here
  // because the key would remount <Layout> (FlexLayout), which triggers
  // an infinite componentDidMount → updateRect → setState → remount loop.
  // BlocksVisibilityProvider resets its IntersectionObserver internally
  // when the scrollRef changes.
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const setTranscriptRef = useCallback((el: HTMLDivElement | null) => {
    transcriptScrollRef.current = el;
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
    if (selectedSessionId) {
      setHasForkHistory(false);
    }
  }, [selectedSessionId]);

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
  const { channelState } = useSessionStatus(selectedSessionId);
  const isStreaming = channelState === 'streaming';

  // --- Auto-scroll ---
  const { parked, isAtTop, scrollToBottom, scrollToTop, pinToBottom } =
    useAutoScroll({
      sessionId: selectedSessionId,
      scrollRef: transcriptScrollRef,
      remount: hasForkHistory,
    });

  // --- Control panel height tracking ---
  useEffect(() => {
    const cpEl = controlPanelRef.current;
    if (!cpEl) return;

    const observer = new ResizeObserver(() => {
      const cpHeight = Math.round(cpEl.getBoundingClientRect().height);
      document.documentElement.style.setProperty(
        '--cp-height',
        String(cpHeight),
      );
    });

    observer.observe(cpEl);
    return () => observer.disconnect();
  }, []);

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
        setSelectedSessionId(null);
        if (text) setPrefillInput({ text });
        return;
      }

      rewindHandlerRef.current?.(atMessageId);
      const text = extractUserText();
      if (text) setPrefillInput({ text });
    },
    [setPrefillInput, setSelectedSessionId],
  );

  // --- Approval resolve with ExitPlanMode orchestration ---
  const handleApprovalResolve = useCallback(
    async (
      optionId: string,
      extra?: ApprovalExtra & { clearContext?: boolean; planContent?: string },
    ) => {
      const { clearContext, planContent, ...transportExtra } = extra ?? {};

      if (clearContext && selectedSessionId) {
        const handoffPrompt = constructExitPlanHandoffPrompt(
          planContent,
          selectedSessionId,
        );

        await resolveApproval(
          optionId,
          Object.keys(transportExtra).length ? transportExtra : undefined,
        );

        try {
          await transport.close(selectedSessionId);
        } catch (err) {
          console.warn('[FlexAppLayout] close session failed:', err);
        }

        setSelectedSessionId(null);

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
    [resolveApproval, selectedSessionId, transport, setSelectedSessionId],
  );

  // --- "Execute in Crispy" postMessage listener ---
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.kind === 'executeInCrispy' && ev.data.content) {
        setSelectedSessionId(null);
        setPrefillInput({ text: ev.data.content });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [setSelectedSessionId]);

  // --- Prefill / agency consumed callbacks ---
  const handlePrefillConsumed = useCallback(() => {
    setPrefillInput(null);
  }, []);

  const handlePendingAgencyModeConsumed = useCallback(
    () => setPendingAgencyMode(null),
    [],
  );

  // --- Sidebar ---
  const closeSidebar = useCallback(() => {
    setSidebarCollapsed(true);
  }, [setSidebarCollapsed]);

  // --- FlexLayout model ---
  const [model] = useState(() => Model.fromJson(FLEX_MODEL));

  // --- Factory ---
  const factory = useCallback(
    (node: TabNode) => {
      switch (node.getComponent()) {
        case 'transcript':
          return (
            <FlexTranscriptContent
              filteredEntries={filteredEntries}
              forkTargets={forkTargets}
              renderMode={renderMode}
              isLoading={isLoading}
              channelState={channelState}
              hasForkHistory={hasForkHistory}
              error={error}
              selectedSessionId={selectedSessionId}
              scrollRef={setTranscriptRef}

              parked={parked}
              isAtTop={isAtTop}
              scrollToBottom={scrollToBottom}
              scrollToTop={scrollToTop}
              onPerMessageFork={handlePerMessageFork}
              onPerMessageRewind={handlePerMessageRewind}
              onForkPreviewHover={handleForkPreviewHover}
            />
          );
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
    [
      filteredEntries,
      forkTargets,
      renderMode,
      isLoading,
      channelState,
      hasForkHistory,
      error,
      selectedSessionId,
      setTranscriptRef,
      parked,
      isAtTop,
      scrollToBottom,
      scrollToTop,
      handlePerMessageFork,
      handlePerMessageRewind,
      handleForkPreviewHover,
    ],
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
        <FlexInsertHandlerBridge setPrefillInput={setPrefillInput} />
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
                <Layout model={model} factory={factory} />
              </main>
              <FileViewerModal />
            </BlocksVisibilityProvider>
          </PanelStateProvider>
        </BlocksToolRegistryProvider>

        {selectedSessionId && !error && <StopButton ref={stopButtonRef} />}
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
        <ControlPanel
          ref={controlPanelRef}
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
      </FilePanelProvider>
    </div>
  );
}
