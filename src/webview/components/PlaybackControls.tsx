/**
 * Playback Controls — collapsible debug toolbar for stepping through entries
 *
 * Collapsed state: thin pill showing "Entry X / Y", click to expand.
 * Expanded state: popover with full transport controls + speed selector.
 *
 * Pure presentational component. All logic lives in usePlayback hook.
 *
 * @module PlaybackControls
 */

import { useState } from 'react';
import type { PlaybackSpeed } from '../hooks/usePlayback.js';

const SPEED_OPTIONS: PlaybackSpeed[] = [1, 2, 5];

interface PlaybackControlsProps {
  visibleCount: number;
  totalEntries: number;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  onPlay: () => void;
  onPause: () => void;
  onStepForward: () => void;
  onStepForward10: () => void;
  onStepBack: () => void;
  onReset: () => void;
  onJumpToEnd: () => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
}

export function PlaybackControls({
  visibleCount,
  totalEntries,
  isPlaying,
  speed,
  onPlay,
  onPause,
  onStepForward,
  onStepForward10,
  onStepBack,
  onReset,
  onJumpToEnd,
  onSpeedChange,
}: PlaybackControlsProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="crispy-playback">
      {/* Collapsed pill — always visible */}
      <button
        className="crispy-playback__pill"
        onClick={() => setExpanded(!expanded)}
        title={expanded ? 'Collapse playback controls' : 'Expand playback controls'}
      >
        <span className="crispy-playback__pill-counter">
          {visibleCount} / {totalEntries}
        </span>
      </button>

      {/* Expanded popover — full controls */}
      {expanded && (
        <div className="crispy-playback__popover">
          <div className="crispy-playback__transport">
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
              className="crispy-playback__btn crispy-playback__btn--skip"
              onClick={onStepForward10}
              disabled={visibleCount >= totalEntries}
              title="Step forward ×10"
            >
              +10
            </button>
            <button
              className="crispy-playback__btn"
              onClick={onJumpToEnd}
              disabled={visibleCount >= totalEntries}
              title="Jump to end"
            >
              ⏭
            </button>
          </div>
          <div className="crispy-playback__speed">
            {SPEED_OPTIONS.map((s) => (
              <button
                key={s}
                className={`crispy-playback__speed-btn ${speed === s ? 'crispy-playback__speed-btn--active' : ''}`}
                onClick={() => onSpeedChange(s)}
                title={`${s}× speed`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
