/**
 * Transcript Viewer — main transcript area with playback and render modes
 *
 * Reads the selected session from SessionContext, loads its transcript
 * via useTranscript, and integrates playback controls via usePlayback.
 *
 * Entry filtering via shouldRenderEntry runs after the playback slice —
 * visibleCount counts raw entries (playback position in the full timeline),
 * then we filter the visible slice for rendering.
 *
 * Renders the ControlPanel as a fixed-position sibling outside the
 * BlocksToolRegistryProvider (it doesn't need registry data). PlaybackControls
 * are gated behind the debugMode preference (toggleable in Settings).
 *
 * @module TranscriptViewer
 */

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { useSession } from "../context/SessionContext.js";
import { usePreferences } from "../context/PreferencesContext.js";
import { useTranscript } from "../hooks/useTranscript.js";
import { usePlayback } from "../hooks/usePlayback.js";
import { useAutoScroll } from "../hooks/useAutoScroll.js";
import { shouldRenderEntry } from "../utils/entry-filters.js";
import { EntryRenderer } from "../renderers/EntryRenderer.js";
import { PlaybackControls } from "./PlaybackControls.js";
import { ForkProvider } from "../context/ForkContext.js";
import { ControlPanel } from "./control-panel/index.js";
import { RenderLocationProvider } from "../context/RenderLocationContext.js";
import { mapPermissionModeToAgency } from './control-panel/types.js';
import type { AgencyMode } from './control-panel/types.js';
import { StopButton } from "./control-panel/StopButton.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { ApprovalContent } from "./approval/index.js";
import { useApprovalRequest } from "../hooks/useApprovalRequest.js";
import { constructExitPlanHandoffPrompt } from "./approval/approval-utils.js";
import { useTransport } from "../context/TransportContext.js";
import { useSessionStatus } from "../hooks/useSessionStatus.js";
import type { ApprovalExtra } from "./approval/types.js";
import type { TranscriptEntry } from "../../core/transcript.js";
import { WelcomePage } from "./WelcomePage.js";
import { isPerfMode, PerfProfiler } from "../perf/index.js";
import { PerfStore } from "../perf/profiler.js";
import { BlocksToolRegistryProvider } from "../blocks/BlocksToolRegistryContext.js";
import { BlocksVisibilityProvider } from "../blocks/BlocksVisibilityContext.js";
import { BlocksToolPanel } from "../blocks/BlocksToolPanel.js";
import { PanelStateProvider } from "../blocks/PanelStateContext.js";

// Debug mode now lives in PreferencesContext (default: on during development).

export function TranscriptViewer(): React.JSX.Element {
  const { selectedSessionId, setSelectedSessionId } = useSession();
  const transport = useTransport();
  const { entries, isLoading, error, addOptimisticEntry, setForkHistory } = useTranscript(selectedSessionId);
  const { renderMode, toolPanelOpen, debugMode } = usePreferences();
  const { approvalRequest, resolve: resolveApproval } = useApprovalRequest(selectedSessionId);
  const [bypassEnabled, setBypassEnabled] = useState(false);
  const [prefillInput, setPrefillInput] = useState<{ text: string; autoSend?: boolean } | null>(null);
  const [pendingAgencyMode, setPendingAgencyMode] = useState<{ agencyMode: AgencyMode; bypassEnabled: boolean } | null>(null);
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

  // Refs for dynamic transcript padding
  const transcriptRef = useRef<HTMLDivElement>(null);
  const controlPanelRef = useRef<HTMLDivElement>(null);
  const stopButtonRef = useRef<HTMLDivElement>(null);

  // Fork history: when in fork mode, we display source session entries before
  // any session is created (selectedSessionId is still null). This flag tells
  // the rendering branch to show the transcript area instead of the placeholder.
  const [hasForkHistory, setHasForkHistory] = useState(false);

  const handleForkHistoryLoaded = useCallback((forkEntries: TranscriptEntry[]) => {
    setForkHistory(forkEntries);
    setHasForkHistory(true);
  }, [setForkHistory]);

  // Clear fork history flag when a real session is selected
  useEffect(() => {
    if (selectedSessionId) {
      setHasForkHistory(false);
    }
  }, [selectedSessionId]);

  // Filter entries for rendering (used for both display and scroll settle detection).
  // Memoized for reference stability — downstream useMemos (forkTargets) and
  // ForkProvider depend on these arrays not changing identity on every render.
  const visibleEntries = useMemo(
    () => entries.slice(0, visibleCount),
    [entries, visibleCount]
  );
  const filterFn = shouldRenderEntry;
  const filteredEntries = useMemo(
    () => visibleEntries.filter(filterFn),
    [visibleEntries, filterFn]
  );

  // Record entry stats for perf profiler
  if (isPerfMode) {
    let blockCount = 0;
    for (const entry of filteredEntries) {
      const content = entry.message?.content;
      blockCount += Array.isArray(content) ? content.length : (content ? 1 : 0);
    }
    PerfStore.recordEntryStats(entries.length, filteredEntries.length, blockCount);
  }

  // --- Per-message fork targets: user UUID → preceding assistant UUID ---
  // First user message gets '' (empty string) sentinel — no assistant to fork
  // from, but rewind should still be available (starts a fresh session).
  const forkTargets = useMemo(() => {
    const targets = new Map<string, string>();
    for (let i = 0; i < filteredEntries.length; i++) {
      const entry = filteredEntries[i];
      if (entry.type !== 'user' || !entry.uuid) continue;
      let found = false;
      for (let j = i - 1; j >= 0; j--) {
        if (filteredEntries[j].type === 'assistant' && filteredEntries[j].uuid) {
          targets.set(entry.uuid, filteredEntries[j].uuid!);
          found = true;
          break;
        }
      }
      // First user message: no preceding assistant — sentinel for rewind-only
      if (!found) {
        targets.set(entry.uuid, '');
      }
    }
    return targets;
  }, [filteredEntries]);

  // Channel state for fork streaming check
  const { channelState } = useSessionStatus(selectedSessionId);

  const { parked, isAtTop, scrollToBottom, scrollToTop, pinToBottom } = useAutoScroll({
    sessionId: selectedSessionId,
    scrollRef: transcriptRef,
    remount: hasForkHistory,
  });

  // Track control panel height for CSS custom property --cp-height.
  // Used by the spacer div, scroll FABs, and stop button for positioning.
  // No scroll compensation — the spacer div inside .crispy-transcript-content
  // makes padding part of content flow, so layout changes are handled naturally.
  useEffect(() => {
    const cpEl = controlPanelRef.current;
    if (!cpEl) return;

    const observer = new ResizeObserver(() => {
      const cpHeight = Math.round(cpEl.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--cp-height', String(cpHeight));
    });

    observer.observe(cpEl);
    return () => observer.disconnect();
  }, []);

  // Fork preview glow: add/remove class on last assistant message
  const handleForkHoverChange = useCallback((hovering: boolean) => {
    if (hovering) {
      const msgs = document.querySelectorAll('.message.assistant');
      const last = msgs[msgs.length - 1];
      if (last) last.classList.add('crispy-fork-preview');
    } else {
      document.querySelectorAll('.message.crispy-fork-preview').forEach((el) => {
        el.classList.remove('crispy-fork-preview');
      });
    }
  }, []);

  // Per-message fork preview: glow a specific assistant message by UUID
  const handleForkPreviewHover = useCallback((targetMessageId: string, hovering: boolean) => {
    if (hovering) {
      const el = document.querySelector(`.message[data-uuid="${targetMessageId}"]`);
      if (el) el.classList.add('crispy-fork-preview');
    } else {
      document.querySelectorAll('.message.crispy-fork-preview').forEach(el =>
        el.classList.remove('crispy-fork-preview')
      );
    }
  }, []);

  // Per-message fork handler — delegates to ControlPanel's executeFork via ref
  const forkHandlerRef = useRef<((atMessageId: string) => void) | null>(null);
  const handleRegisterForkHandler = useCallback((handler: (atMessageId: string) => void) => {
    forkHandlerRef.current = handler;
  }, []);
  const handlePerMessageFork = useCallback((atMessageId: string) => {
    forkHandlerRef.current?.(atMessageId);
  }, []);

  // Per-message rewind handler — delegates to ControlPanel's executeRewind via ref,
  // then extracts the original user text and prefills the chat input.
  // Uses refs for forkTargets/filteredEntries to keep the callback stable
  // (same pattern as handlePerMessageFork uses forkHandlerRef).
  const rewindHandlerRef = useRef<((atMessageId: string) => void) | null>(null);
  const handleRegisterRewindHandler = useCallback((handler: (atMessageId: string) => void) => {
    rewindHandlerRef.current = handler;
  }, []);
  const forkTargetsRef = useRef(forkTargets);
  forkTargetsRef.current = forkTargets;
  const filteredEntriesRef = useRef(filteredEntries);
  filteredEntriesRef.current = filteredEntries;

  const handlePerMessageRewind = useCallback((atMessageId: string) => {
    // Extract user text from the entry whose fork target matches atMessageId
    const extractUserText = (): string => {
      for (const [userUUID, assistantUUID] of forkTargetsRef.current.entries()) {
        if (assistantUUID === atMessageId) {
          const userEntry = filteredEntriesRef.current.find(e => e.uuid === userUUID);
          if (userEntry?.message?.content) {
            const content = userEntry.message.content;
            return Array.isArray(content)
              ? content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('\n')
              : typeof content === 'string' ? content : '';
          }
          break;
        }
      }
      return '';
    };

    if (!atMessageId) {
      // First user message sentinel: no fork, just clear session and prefill
      const text = extractUserText();
      setSelectedSessionId(null);
      if (text) setPrefillInput({ text });
      return;
    }

    // Normal rewind: trigger ControlPanel's executeRewind (loads fork history, sets fork mode)
    rewindHandlerRef.current?.(atMessageId);
    const text = extractUserText();
    if (text) setPrefillInput({ text });
  }, [setPrefillInput, setSelectedSessionId]);

  // Wrap resolveApproval to intercept ExitPlanMode orchestration fields
  // (clearContext, planContent) before forwarding to transport.
  const handleApprovalResolve = useCallback(
    async (optionId: string, extra?: ApprovalExtra & { clearContext?: boolean; planContent?: string }) => {
      // Strip non-transport fields before forwarding
      const { clearContext, planContent, ...transportExtra } = extra ?? {};

      if (clearContext && selectedSessionId) {
        // ExitPlanMode with context clear: resolve approval, close old session,
        // null out selection (clears transcript), and prefill handoff prompt.
        const handoffPrompt = constructExitPlanHandoffPrompt(planContent, selectedSessionId);

        // Resolve the approval first — SDK needs the PermissionResult before we tear down
        await resolveApproval(optionId, Object.keys(transportExtra).length ? transportExtra : undefined);

        // Close the old session — tears down the adapter and channel
        try {
          await transport.close(selectedSessionId);
        } catch (err) {
          // Session may already be closed; proceed anyway
          console.warn('[TranscriptViewer] close session failed:', err);
        }

        // Null out session selection — clears transcript (useTranscript resets),
        // clears approval UI (useApprovalRequest clears on session change)
        setSelectedSessionId(null);

        // Push the chosen permission mode into ControlPanel state so the
        // new session is created with the correct permissionMode.
        const targetMode = (transportExtra.updatedPermissions?.[0] as { mode?: string })?.mode;
        if (targetMode) {
          const agencyMode = mapPermissionModeToAgency(targetMode);
          if (agencyMode) {
            setPendingAgencyMode({ agencyMode, bypassEnabled: targetMode === 'bypassPermissions' });
          }
        }

        // Prefill ChatInput with the handoff prompt and auto-send
        setPrefillInput({ text: handoffPrompt, autoSend: true });
        return;
      }

      // Normal approval resolution path
      await resolveApproval(optionId, Object.keys(transportExtra).length ? transportExtra : undefined);
    },
    [resolveApproval, selectedSessionId, transport, setSelectedSessionId],
  );

  // Listen for "Execute in Crispy" postMessage from the extension host.
  // Clears the current session so handleSend takes the new-session branch,
  // then prefills + auto-sends the file content.
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.data?.kind === 'executeInCrispy' && ev.data.content) {
        setSelectedSessionId(null);
        setPrefillInput({ text: ev.data.content, autoSend: true });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [setSelectedSessionId]);

  // Callback to clear prefillInput after ControlPanel consumes it
  const handlePrefillConsumed = useCallback(() => {
    setPrefillInput(null);
  }, []);

  // Callback to clear pendingAgencyMode after ControlPanel consumes it
  const handlePendingAgencyModeConsumed = useCallback(() => setPendingAgencyMode(null), []);

  // --- Main content area (conditional) ---
  // ControlPanel is rendered once, outside the conditional branches, so it is
  // never unmounted when selectedSessionId transitions from null → pending.
  // This preserves user-chosen state (agency mode, model, bypass) across the
  // new-session flow instead of resetting to defaults on remount.

  let mainContent: React.JSX.Element;

  if (!selectedSessionId && !hasForkHistory) {
    mainContent = <WelcomePage loading={isLoading} />;
  } else if (error) {
    mainContent = <div className="crispy-error">{error}</div>;
  } else {
    const transcriptArea = (
      <RenderLocationProvider location="transcript">
      <ForkProvider
        onFork={handlePerMessageFork}
        onRewind={handlePerMessageRewind}
        onForkPreviewHover={handleForkPreviewHover}
        isStreaming={channelState === 'streaming'}
        forkTargets={forkTargets}
      >
        <div className="crispy-transcript" ref={transcriptRef} data-render-mode={renderMode}>
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
                    forkTargetId={entry.uuid ? forkTargets.get(entry.uuid) : undefined}
                  />
                ))}
              </PerfProfiler>
            )}
            <ThinkingIndicator />
            {/* Spacer: reserves space for the fixed control panel + stop button + gap.
                Sized via CSS using --cp-height. Always reserves stop button space so
                layout doesn't shift when it appears/disappears. */}
            <div className="crispy-transcript-spacer" />
          </div>
        </div>
      <button
        className={`crispy-scroll-nav crispy-scroll-to-top ${isAtTop ? 'crispy-scroll-to-top--hidden' : ''}`}
        onClick={scrollToTop}
        aria-label="Scroll to top"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        className={`crispy-scroll-nav crispy-scroll-to-bottom ${parked ? 'crispy-scroll-to-bottom--hidden' : ''}`}
        onClick={scrollToBottom}
        aria-label="Scroll to bottom"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      </ForkProvider>
      </RenderLocationProvider>
    );

    mainContent = (
      <BlocksToolRegistryProvider entries={visibleEntries} sessionId={selectedSessionId}>
        <PanelStateProvider>
          <BlocksVisibilityProvider scrollRef={transcriptRef}>
            {transcriptArea}
            {toolPanelOpen && <BlocksToolPanel />}
          </BlocksVisibilityProvider>
        </PanelStateProvider>
      </BlocksToolRegistryProvider>
    );
  }

  return (
    <>
      {mainContent}
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
    </>
  );
}
