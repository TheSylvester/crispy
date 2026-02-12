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

import { useRef, useEffect, useCallback } from "react";
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

/** Check once whether debug mode is enabled */
const isDebugMode = window.location.search.includes('debug=1');

export function TranscriptViewer(): React.JSX.Element {
  const { selectedSessionId } = useSession();
  const { entries, isLoading, error, addOptimisticEntry } = useTranscript(selectedSessionId);
  const { renderMode } = usePreferences();
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

  // Refs for dynamic transcript padding and auto-scroll
  const transcriptRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controlPanelRef = useRef<HTMLDivElement>(null);

  // Filter entries for rendering (used for both display and scroll settle detection)
  const visibleEntries = entries.slice(0, visibleCount);
  const filteredEntries = visibleEntries.filter(shouldRenderEntry);

  const { isSticky, isAtTop, scrollToBottom, scrollToTop, contentReady } = useAutoScroll({
    containerRef: transcriptRef,
    contentRef,
    entryCount: filteredEntries.length,
    sessionId: selectedSessionId,
  });

  // Observe control panel height for dynamic transcript bottom padding
  useEffect(() => {
    const cpEl = controlPanelRef.current;
    const txEl = transcriptRef.current;
    if (!cpEl || !txEl) return;

    const updatePadding = () => {
      const height = cpEl.getBoundingClientRect().height;
      txEl.style.paddingBottom = `${height + 32}px`;
      document.documentElement.style.setProperty('--cp-height', String(Math.round(height)));
    };

    const observer = new ResizeObserver(updatePadding);
    observer.observe(cpEl);
    updatePadding(); // Initial measurement

    return () => observer.disconnect();
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

  if (!selectedSessionId) {
    return (
      <>
        <div className="crispy-placeholder">
          Select a session or start a new conversation
        </div>
        <ControlPanel
          ref={controlPanelRef}
          onForkHoverChange={handleForkHoverChange}
        />
      </>
    );
  }

  if (error) {
    return <div className="crispy-error">{error}</div>;
  }

  return (
    <>
      <ToolRegistryProvider entries={visibleEntries} sessionId={selectedSessionId}>
        <div className="crispy-transcript" ref={transcriptRef}>
          <div ref={contentRef} className={`crispy-transcript-content ${contentReady ? 'crispy-transcript-content--visible' : ''}`}>
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
      <StopButton />
      <ControlPanel
        ref={controlPanelRef}
        onForkHoverChange={handleForkHoverChange}
        onOptimisticEntry={addOptimisticEntry}
      />
    </>
  );
}
