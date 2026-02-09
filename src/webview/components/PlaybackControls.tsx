/**
 * Playback Controls — debug toolbar for stepping through entries
 *
 * Pure presentational component. All logic lives in usePlayback hook.
 * Buttons: ⏮ (reset) | ◀ (step back) | ▶/⏸ (play/pause) | ▶ (step forward) | ⏭ (jump to end)
 * Counter: "Entry X of Y"
 *
 * @module PlaybackControls
 */

interface PlaybackControlsProps {
  visibleCount: number;
  totalEntries: number;
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStepForward: () => void;
  onStepBack: () => void;
  onReset: () => void;
  onJumpToEnd: () => void;
}

export function PlaybackControls({
  visibleCount,
  totalEntries,
  isPlaying,
  onPlay,
  onPause,
  onStepForward,
  onStepBack,
  onReset,
  onJumpToEnd,
}: PlaybackControlsProps): React.JSX.Element {
  return (
    <div className="crispy-playback">
      <button
        className="crispy-playback__btn"
        onClick={onReset}
        disabled={visibleCount === 0}
        title="Reset to start"
      >
        ⏮
      </button>
      <button
        className="crispy-playback__btn"
        onClick={onStepBack}
        disabled={visibleCount === 0}
        title="Step back"
      >
        ◀
      </button>
      <button
        className="crispy-playback__btn"
        onClick={isPlaying ? onPause : onPlay}
        disabled={totalEntries === 0}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? '⏸' : '▶'}
      </button>
      <button
        className="crispy-playback__btn"
        onClick={onStepForward}
        disabled={visibleCount >= totalEntries}
        title="Step forward"
      >
        ▶▶
      </button>
      <button
        className="crispy-playback__btn"
        onClick={onJumpToEnd}
        disabled={visibleCount >= totalEntries}
        title="Jump to end"
      >
        ⏭
      </button>
      <span className="crispy-playback__counter">
        Entry {visibleCount} of {totalEntries}
      </span>
    </div>
  );
}
