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
 * ToolRegistryProvider (it doesn't need registry data). PlaybackControls
 * are gated behind ?debug=1 URL param.
 *
 * @module TranscriptViewer
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { useSession } from "../context/SessionContext.js";
import { usePreferences } from "../context/PreferencesContext.js";
import { useTranscript } from "../hooks/useTranscript.js";
import { usePlayback } from "../hooks/usePlayback.js";
import { useAutoScroll } from "../hooks/useAutoScroll.js";
import { shouldRenderEntry } from "../utils/entry-filters.js";
import { EntryRenderer } from "../renderers/EntryRenderer.js";
import { PlaybackControls } from "./PlaybackControls.js";
import { ToolRegistryProvider } from "../context/ToolRegistryContext.js";
import { ControlPanel } from "./control-panel/index.js";
import { StopButton } from "./control-panel/StopButton.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { ApprovalContent } from "./approval/index.js";
import { useApprovalRequest } from "../hooks/useApprovalRequest.js";
import { constructExitPlanHandoffPrompt } from "./approval/approval-utils.js";
import { useTransport } from "../context/TransportContext.js";
import type { ApprovalExtra } from "./approval/types.js";
import type { TranscriptEntry } from "../../core/transcript.js";

/** Check once whether debug mode is enabled */
const isDebugMode = window.location.search.includes('debug=1');

export function TranscriptViewer(): React.JSX.Element {
  const { selectedSessionId, setSelectedSessionId } = useSession();
  const transport = useTransport();
  const { entries, isLoading, error, addOptimisticEntry } = useTranscript(selectedSessionId);
  const { renderMode } = usePreferences();
  const { approvalRequest, resolve: resolveApproval } = useApprovalRequest(selectedSessionId);
  const [bypassEnabled, setBypassEnabled] = useState(false);
  const [prefillInput, setPrefillInput] = useState<string | null>(null);
  const {
    visibleCount,
    isPlaying,
    play,
    pause,
    stepForward,
    stepBack,
    reset,
    jumpToEnd,
  } = usePlayback(entries.length);

  // Refs for dynamic transcript padding
  const transcriptRef = useRef<HTMLDivElement>(null);
  const controlPanelRef = useRef<HTMLDivElement>(null);
  const stopButtonRef = useRef<HTMLDivElement>(null);

  // Pending optimistic entry: stashed by ControlPanel in the new-session branch,
  // injected into useTranscript once the pending session ID initializes.
  const pendingOptimisticRef = useRef<TranscriptEntry | null>(null);

  const handlePendingOptimisticEntry = useCallback((entry: TranscriptEntry) => {
    pendingOptimisticRef.current = entry;
  }, []);

  // Inject the pending optimistic entry when useTranscript initializes for a
  // pending session (entries are empty, not loading, no error).
  useEffect(() => {
    if (
      selectedSessionId?.startsWith('pending:') &&
      pendingOptimisticRef.current &&
      !isLoading &&
      entries.length === 0
    ) {
      const entry = pendingOptimisticRef.current;
      pendingOptimisticRef.current = null;
      addOptimisticEntry(entry);
    }
  }, [selectedSessionId, isLoading, entries.length, addOptimisticEntry]);

  // Clear stale pending optimistic entry when switching to a non-pending session.
  // Without this, a stashed entry from a previous new-session flow could leak
  // into an unrelated session if the user switches away before it was injected.
  useEffect(() => {
    if (selectedSessionId && !selectedSessionId.startsWith('pending:')) {
      pendingOptimisticRef.current = null;
    }
  }, [selectedSessionId]);

  // Filter entries for rendering (used for both display and scroll settle detection)
  const visibleEntries = entries.slice(0, visibleCount);
  const filteredEntries = visibleEntries.filter(shouldRenderEntry);

  const { isSticky, isAtTop, scrollToBottom, scrollToTop, pinToBottom } = useAutoScroll({
    sessionId: selectedSessionId,
  });

  // Observe control panel + stop button for dynamic transcript bottom padding.
  // The stop button floats above the control panel; when visible its height must be
  // included so the last transcript entry isn't hidden behind it.
  //
  // ResizeObserver fires on control panel size changes. The stop button doesn't resize
  // (it's always in the DOM at fixed size, toggled via opacity/transform), so we use a
  // MutationObserver on its classList to detect visibility transitions.
  useEffect(() => {
    const cpEl = controlPanelRef.current;
    const sbEl = stopButtonRef.current;
    const txEl = transcriptRef.current;
    if (!cpEl || !txEl) return;

    const GAP = 32; // px spacer between content and control panel

    const updatePadding = () => {
      const cpHeight = cpEl.getBoundingClientRect().height;
      // Stop button is always in the DOM but invisible (opacity: 0) when idle.
      // Only add its height when it has the --visible class.
      const sbVisible = sbEl?.classList.contains('crispy-stop--visible');
      const sbHeight = sbVisible ? sbEl!.getBoundingClientRect().height : 0;

      txEl.style.paddingBottom = `${cpHeight + sbHeight + GAP}px`;
      document.documentElement.style.setProperty('--cp-height', String(Math.round(cpHeight)));
    };

    // Watch control panel for size changes (e.g. textarea grow)
    const resizeObs = new ResizeObserver(updatePadding);
    resizeObs.observe(cpEl);

    // Watch stop button for class changes (visible ↔ hidden)
    let mutationObs: MutationObserver | undefined;
    if (sbEl) {
      mutationObs = new MutationObserver(updatePadding);
      mutationObs.observe(sbEl, { attributes: true, attributeFilter: ['class'] });
    }

    updatePadding(); // Initial measurement

    return () => {
      resizeObs.disconnect();
      mutationObs?.disconnect();
    };
  }, [selectedSessionId]); // Re-attach when session changes

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

        // Prefill ChatInput with the handoff prompt
        setPrefillInput(handoffPrompt);
        return;
      }

      // Normal approval resolution path
      await resolveApproval(optionId, Object.keys(transportExtra).length ? transportExtra : undefined);
    },
    [resolveApproval, selectedSessionId, transport, setSelectedSessionId],
  );

  // Callback to clear prefillInput after ControlPanel consumes it
  const handlePrefillConsumed = useCallback(() => {
    setPrefillInput(null);
  }, []);

  // --- Main content area (conditional) ---
  // ControlPanel is rendered once, outside the conditional branches, so it is
  // never unmounted when selectedSessionId transitions from null → pending.
  // This preserves user-chosen state (agency mode, model, bypass) across the
  // new-session flow instead of resetting to defaults on remount.

  let mainContent: React.JSX.Element;

  if (!selectedSessionId) {
    mainContent = (
      <div className="crispy-placeholder">
        Select a session or start a new conversation
      </div>
    );
  } else if (error) {
    mainContent = <div className="crispy-error">{error}</div>;
  } else {
    mainContent = (
      <ToolRegistryProvider entries={visibleEntries} sessionId={selectedSessionId}>
        <div className="crispy-transcript" ref={transcriptRef}>
          <div className="crispy-transcript-content">
            {isLoading ? (
              <div className="crispy-loading">Loading transcript...</div>
            ) : (
              filteredEntries
                .map((entry, i) => (
                  <EntryRenderer
                    key={entry.uuid ?? `entry-${i}`}
                    entry={entry}
                    mode={renderMode}
                  />
                ))
            )}
            <ThinkingIndicator />
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
          className={`crispy-scroll-nav crispy-scroll-to-bottom ${isSticky ? 'crispy-scroll-to-bottom--hidden' : ''}`}
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {isDebugMode && (
          <PlaybackControls
            visibleCount={visibleCount}
            totalEntries={entries.length}
            isPlaying={isPlaying}
            onPlay={play}
            onPause={pause}
            onStepForward={stepForward}
            onStepBack={stepBack}
            onReset={reset}
            onJumpToEnd={jumpToEnd}
          />
        )}
      </ToolRegistryProvider>
    );
  }

  return (
    <>
      {mainContent}
      {selectedSessionId && !error && <StopButton ref={stopButtonRef} />}
      <ControlPanel
        ref={controlPanelRef}
        onForkHoverChange={handleForkHoverChange}
        onOptimisticEntry={selectedSessionId ? addOptimisticEntry : undefined}
        onPendingOptimisticEntry={handlePendingOptimisticEntry}
        onScrollToBottom={pinToBottom}
        entries={entries}
        onBypassChange={setBypassEnabled}
        prefillInput={prefillInput}
        onPrefillConsumed={handlePrefillConsumed}
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
