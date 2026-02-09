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
 * @module TranscriptViewer
 */

import { useState } from "react";
import { useSession } from "../context/SessionContext.js";
import { useTranscript } from "../hooks/useTranscript.js";
import { usePlayback } from "../hooks/usePlayback.js";
import { shouldRenderEntry } from "../utils/entry-filters.js";
import { EntryRenderer } from "../renderers/EntryRenderer.js";
import { PlaybackControls } from "./PlaybackControls.js";
import type { RenderMode } from "../types.js";

const MODES: readonly RenderMode[] = ["yaml", "compact", "rich"] as const;

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

  return (
    <>
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
      <div className="crispy-transcript">
        {isLoading ? (
          <div className="crispy-loading">Loading transcript...</div>
        ) : (
          entries
            .slice(0, visibleCount)
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
    </>
  );
}
