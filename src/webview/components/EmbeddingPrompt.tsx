/**
 * Embedding Prompt — modal overlay prompting the user to start semantic embedding
 *
 * Shows when the catch-up manager detects >200 unembedded messages. Renders as
 * a portal on document.body (same pattern as ImageLightbox.tsx) to avoid
 * stacking-context traps.
 *
 * Dismisses on "Not Now" (local state, not persisted — reappears next activation).
 * "Start Now" triggers the embedding backfill and dismisses.
 *
 * @module webview/components/EmbeddingPrompt
 */

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { CatchupStatus } from '../../core/recall/catchup-types.js';
import { formatDuration } from '../utils/format.js';

interface EmbeddingPromptProps {
  status: CatchupStatus;
  onStart: () => void;
}

export function EmbeddingPrompt({ status, onStart }: EmbeddingPromptProps): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);

  // Only show when detecting-gap phase with large gap
  const shouldShow =
    !dismissed &&
    status.phase === 'detecting-gap' &&
    status.gapCount > 200;

  // Dismiss on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true);
    },
    [],
  );

  useEffect(() => {
    if (!shouldShow) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [shouldShow, handleKeyDown]);

  if (!shouldShow) return null;

  const handleStart = () => {
    onStart();
    setDismissed(true);
  };

  return createPortal(
    <div
      className="crispy-embedding-prompt__backdrop"
      onClick={() => setDismissed(true)}
      role="dialog"
      aria-label="Semantic search setup"
      aria-modal="true"
    >
      <div
        className="crispy-embedding-prompt__card"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="crispy-embedding-prompt__title">Semantic Search Setup</h3>
        <p className="crispy-embedding-prompt__body">
          Found <strong>{status.gapCount.toLocaleString()}</strong> messages that
          can be embedded for better search results.
        </p>
        {status.estimatedSecondsRemaining > 0 && (
          <p className="crispy-embedding-prompt__estimate">
            Estimated time: ~{formatDuration(status.estimatedSecondsRemaining, 'long')} (runs in background)
          </p>
        )}
        <div className="crispy-embedding-prompt__actions">
          <button
            className="crispy-embedding-prompt__btn crispy-embedding-prompt__btn--primary"
            onClick={handleStart}
          >
            Start Now
          </button>
          <button
            className="crispy-embedding-prompt__btn"
            onClick={() => setDismissed(true)}
          >
            Not Now
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
