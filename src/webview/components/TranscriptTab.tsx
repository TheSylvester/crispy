/**
 * TranscriptTab — self-contained transcript tab with embedded ControlPanel,
 * StopButton, and approval UI.
 *
 * Each FlexLayout transcript tab renders one TranscriptTab. The component
 * manages its own session lifecycle, fork/rewind handlers, scroll, and
 * approval resolution independently. A single `<TabSessionProvider>` wraps
 * all return paths, composing the per-tab providers internally.
 *
 * @module TranscriptTab
 */

import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { usePreferences } from '../context/PreferencesContext.js';
import { useSessionData, useChannelState } from '../hooks/useChannelStore.js';
import { usePlayback } from '../hooks/usePlayback.js';
import { useAutoScroll } from '../hooks/useAutoScroll.js';
import { shouldRenderEntry } from '../utils/entry-filters.js';
import { YamlEntry } from '../renderers/YamlEntry.js';
import { CompactEntry } from '../renderers/CompactEntry.js';
import { BlocksEntry } from '../blocks/BlocksEntry.js';
import { ControlPanel } from './control-panel/index.js';
import { mapPermissionModeToAgency } from './control-panel/types.js';
import type { AgencyMode } from './control-panel/types.js';
import { StopButton } from './control-panel/StopButton.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
import { ApprovalContent } from './approval/index.js';
import { useApprovalRequest } from '../hooks/useApprovalRequest.js';
import { constructExitPlanHandoffPrompt } from './approval/approval-utils.js';
import { useTransport } from '../context/TransportContext.js';
// (useChannelState imported from useChannelStore.js above)
import type { ApprovalExtra } from './approval/types.js';
import type { TranscriptEntry } from '../../core/transcript.js';
import { WelcomePage } from './WelcomePage.js';
import { isPerfMode, PerfProfiler } from '../perf/index.js';
import { PerfStore } from '../perf/profiler.js';
import { TabSessionProvider } from '../context/TabSessionContext.js';
import { TranscriptHeader } from './TranscriptHeader.js';

// ============================================================================
// Types
// ============================================================================

export interface TranscriptTabProps {
  tabId: string;
  isActiveTab: boolean;
  /** Per-tab session ID (null = no session / welcome). */
  sessionId: string | null;
  /** Update this tab's session ID in the parent tabSessions map. */
  onSessionIdChange: (id: string | null) => void;
  /** Ensure this tab becomes the active tab (syncs global session state). */
  onActivateTab: () => void;
}

// ============================================================================
// TranscriptTab
// ============================================================================

export function TranscriptTab({
  tabId,
  isActiveTab,
  sessionId: tabSessionId,
  onSessionIdChange,
}: TranscriptTabProps): React.JSX.Element {
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
  } = useSessionData(tabSessionId);
  const { renderMode } = usePreferences();
  const isBlocksMode = renderMode === 'blocks';
  const EntryComponent = useMemo(() => {
    switch (renderMode) {
      case 'yaml':    return YamlEntry;
      case 'compact': return CompactEntry;
      case 'blocks':  return BlocksEntry;
    }
  }, [renderMode]);
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
  const { channelState } = useChannelState(tabSessionId);

  // --- Turn completion map (blocks mode only) ---
  // For each assistant entry, determines whether the turn is complete
  // (not actively streaming). Used by BlocksEntry to collapse ephemeral tools.
  const turnCompleteMap = useMemo(() => {
    if (!isBlocksMode) return null;
    const map = new Map<string, boolean>();
    const isStreaming = channelState === 'streaming';
    for (let i = 0; i < filteredEntries.length; i++) {
      const entry = filteredEntries[i];
      if (entry.type !== 'assistant') continue;
      const uuid = entry.uuid;
      if (!uuid) continue;
      // Turn is complete when:
      // 1. Next entry is a user entry (turn boundary), OR
      // 2. It's the last entry AND the channel is NOT streaming
      const nextEntry = filteredEntries[i + 1];
      const isLast = i === filteredEntries.length - 1;
      const turnComplete = nextEntry
        ? nextEntry.type === 'user'
        : !isStreaming;
      map.set(uuid, turnComplete);
    }
    return map;
  }, [isBlocksMode, filteredEntries, channelState]);

  // --- Auto-scroll ---
  const { parked, isAtTop, scrollToBottom, scrollToTop, pinToBottom } =
    useAutoScroll({
      sessionId: tabSessionId,
      scrollRef: transcriptScrollRef,
      remount: hasForkHistory,
    });

  // --- Fork preview glow ---
  const handleForkHoverChange = useCallback((hovering: boolean) => {
    const root = transcriptScrollRef.current;
    if (!root) return;
    if (hovering) {
      const msgs = root.querySelectorAll('.message.assistant');
      const last = msgs[msgs.length - 1];
      if (last) last.classList.add('crispy-fork-preview');
    } else {
      root
        .querySelectorAll('.message.crispy-fork-preview')
        .forEach((el) => {
          el.classList.remove('crispy-fork-preview');
        });
    }
  }, []);

  const handleForkPreviewHover = useCallback(
    (targetMessageId: string, hovering: boolean) => {
      const root = transcriptScrollRef.current;
      if (!root) return;
      if (hovering) {
        const el = root.querySelector(
          `.message[data-uuid="${targetMessageId}"]`,
        );
        if (el) el.classList.add('crispy-fork-preview');
      } else {
        root
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

  // --- ExitPlanMode session migration (tab-level orchestration) ---
  // Resolve approval → close session → clear tab → set agency mode → prefill handoff.
  const handleExitPlanMigration = useCallback(
    async (
      optionId: string,
      extra: ApprovalExtra & { planContent?: string },
    ) => {
      const { planContent, ...transportExtra } = extra;
      const handoffPrompt = constructExitPlanHandoffPrompt(
        planContent,
        tabSessionId,
      );

      await resolveApproval(
        optionId,
        Object.keys(transportExtra).length ? transportExtra : undefined,
      );

      try {
        await transport.close(tabSessionId!);
      } catch (err) {
        console.warn('[TranscriptTab] close session failed:', err);
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
    },
    [resolveApproval, tabSessionId, transport, onSessionIdChange],
  );

  // --- Approval resolve ---
  // Routes ExitPlanMode with clearContext to the migration handler;
  // everything else is a plain approval resolution.
  const handleApprovalResolve = useCallback(
    async (
      optionId: string,
      extra?: ApprovalExtra & { clearContext?: boolean; planContent?: string },
    ) => {
      const { clearContext, ...rest } = extra ?? {};

      if (clearContext && tabSessionId) {
        return handleExitPlanMigration(optionId, rest);
      }

      const { planContent: _, ...transportExtra } = rest;
      await resolveApproval(
        optionId,
        Object.keys(transportExtra).length ? transportExtra : undefined,
      );
    },
    [handleExitPlanMigration, resolveApproval, tabSessionId],
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

  // --- Session selected from dropdown ---
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      onSessionIdChange(sessionId);
    },
    [onSessionIdChange],
  );

  // No session and no fork history → welcome page (with ControlPanel still)
  if (!tabSessionId && !hasForkHistory) {
    return (
      <TabSessionProvider
        entries={visibleEntries}
        sessionId={tabSessionId}
        isActiveTab={isActiveTab}
        scrollRef={transcriptScrollRef}
      >
        <div className="crispy-transcript-tab" data-tab-id={tabId} data-streaming={channelState === 'streaming' || undefined}>
          <TranscriptHeader onNewSession={handleNewSession} onSelectSession={handleSelectSession} sessionId={tabSessionId} />
          <WelcomePage loading={isLoading} />
          <StopButton sessionId={tabSessionId} />
          <ControlPanel
            ref={cpElRef}
            sessionId={tabSessionId}
            tabId={tabId}
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
      </TabSessionProvider>
    );
  }

  if (error) {
    return (
      <TabSessionProvider
        entries={visibleEntries}
        sessionId={tabSessionId}
        isActiveTab={isActiveTab}
        scrollRef={transcriptScrollRef}
      >
        <div className="crispy-transcript-tab" data-tab-id={tabId} data-streaming={channelState === 'streaming' || undefined}>
          <TranscriptHeader onNewSession={handleNewSession} onSelectSession={handleSelectSession} sessionId={tabSessionId} />
          <div className="crispy-error">{error}</div>
        </div>
      </TabSessionProvider>
    );
  }

  return (
    <TabSessionProvider
      entries={visibleEntries}
      sessionId={tabSessionId}
      isActiveTab={isActiveTab}
      scrollRef={transcriptScrollRef}
      onFork={handlePerMessageFork}
      onRewind={handlePerMessageRewind}
      onForkPreviewHover={handleForkPreviewHover}
      isStreaming={channelState === 'streaming'}
      forkTargets={forkTargets}
    >
      <div className="crispy-transcript-tab" data-tab-id={tabId} data-streaming={channelState === 'streaming' || undefined}>
        <TranscriptHeader onNewSession={handleNewSession} onSelectSession={handleSelectSession} sessionId={tabSessionId} />
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
                  <EntryComponent
                    key={entry.uuid ?? `entry-${i}`}
                    entry={entry}
                    {...(turnCompleteMap && entry.uuid
                      ? { isTurnComplete: turnCompleteMap.get(entry.uuid) }
                      : undefined
                    )}
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
          tabId={tabId}
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
    </TabSessionProvider>
  );
}
