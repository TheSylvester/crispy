/**
 * Transcript Viewer — main transcript area with playback and render modes
 *
 * Reads the selected session from SessionContext, loads its transcript
 * via useTranscript, integrates playback controls via usePlayback, and
 * provides a render mode switcher (YAML / Compact / Rich).
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

import { useState, useRef, useEffect, useCallback } from "react";
import { useSession } from "../context/SessionContext.js";
import { useTranscript } from "../hooks/useTranscript.js";
import { usePlayback } from "../hooks/usePlayback.js";
import { shouldRenderEntry } from "../utils/entry-filters.js";
import { EntryRenderer } from "../renderers/EntryRenderer.js";
import { PlaybackControls } from "./PlaybackControls.js";
import { ToolRegistryProvider } from "../context/ToolRegistryContext.js";
import { ControlPanel } from "./control-panel/index.js";
import type { RenderMode } from "../types.js";

const MODES: readonly RenderMode[] = ["yaml", "compact", "rich"] as const;

/** Check once whether debug mode is enabled */
const isDebugMode = window.location.search.includes('debug=1');

export function TranscriptViewer(): React.JSX.Element {
  const { selectedSessionId } = useSession();
  const { entries, isLoading, error } = useTranscript(selectedSessionId);
  const [renderMode, setRenderMode] = useState<RenderMode>("rich");
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

  // Observe control panel height for dynamic transcript bottom padding
  useEffect(() => {
    const cpEl = controlPanelRef.current;
    const txEl = transcriptRef.current;
    if (!cpEl || !txEl) return;

    const updatePadding = () => {
      const height = cpEl.getBoundingClientRect().height;
      txEl.style.paddingBottom = `${height + 32}px`;
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
      <div className="crispy-placeholder">
        Select a session to view its transcript
      </div>
    );
  }

  if (error) {
    return <div className="crispy-error">{error}</div>;
  }

  // Slice entries to playback position — registry only processes entries
  // up to visibleCount, so tool status matches the playback timeline.
  const visibleEntries = entries.slice(0, visibleCount);

  return (
    <>
      <ToolRegistryProvider entries={visibleEntries} sessionId={selectedSessionId}>
        <div className="crispy-mode-switcher">
          {MODES.map((mode) => (
            <button
              key={mode}
              className={`crispy-mode-btn ${renderMode === mode ? "crispy-mode-btn--active" : ""}`}
              onClick={() => setRenderMode(mode)}
            >
              {mode.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="crispy-transcript" ref={transcriptRef}>
          {isLoading ? (
            <div className="crispy-loading">Loading transcript...</div>
          ) : (
            visibleEntries
              .filter(shouldRenderEntry)
              .map((entry, i) => (
                <EntryRenderer
                  key={entry.uuid ?? `entry-${i}`}
                  entry={entry}
                  mode={renderMode}
                />
              ))
          )}
        </div>
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
      <ControlPanel
        ref={controlPanelRef}
        onForkHoverChange={handleForkHoverChange}
      />
    </>
  );
}
