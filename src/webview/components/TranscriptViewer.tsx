/**
 * Transcript Viewer — main transcript area with playback integration
 *
 * Reads the selected session from SessionContext, loads its transcript
 * via useTranscript, and integrates playback controls via usePlayback.
 *
 * @module TranscriptViewer
 */

import { useSession } from '../context/SessionContext.js';
import { useTranscript } from '../hooks/useTranscript.js';
import { usePlayback } from '../hooks/usePlayback.js';
import { EntryRenderer } from './EntryRenderer.js';
import { PlaybackControls } from './PlaybackControls.js';

export function TranscriptViewer(): React.JSX.Element {
  const { selectedSessionId } = useSession();
  const { entries, isLoading, error } = useTranscript(selectedSessionId);
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
      <div className="crispy-transcript">
        {isLoading ? (
          <div className="crispy-loading">Loading transcript...</div>
        ) : (
          entries.slice(0, visibleCount).map((entry, i) => (
            <EntryRenderer key={entry.uuid ?? i} entry={entry} index={i} />
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
