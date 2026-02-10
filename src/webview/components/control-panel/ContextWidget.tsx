/**
 * Context Widget — percentage display with tooltip
 *
 * Shows context usage as "💿 42%" with color-coded percentage.
 * Click toggles a pinned tooltip with history. Click-outside closes.
 *
 * @module control-panel/ContextWidget
 */

import { useState, useRef, useEffect, useCallback } from 'react';

interface ContextWidgetProps {
  percent: number;
}

/** Returns CSS class for context percentage color. */
function getColorClass(percent: number): string {
  if (percent <= 10) return 'crispy-cp-context--minimal';
  if (percent <= 20) return 'crispy-cp-context--low';
  if (percent <= 40) return 'crispy-cp-context--healthy';
  if (percent <= 60) return 'crispy-cp-context--moderate';
  if (percent <= 80) return 'crispy-cp-context--high';
  return 'crispy-cp-context--critical';
}

export function ContextWidget({ percent }: ContextWidgetProps): React.JSX.Element {
  const [pinned, setPinned] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (pinned && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPinned(false);
      }
    },
    [pinned],
  );

  useEffect(() => {
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [handleClickOutside]);

  const colorClass = getColorClass(percent);

  return (
    <span
      ref={containerRef}
      className={`crispy-cp-context-container ${pinned ? 'crispy-cp-context-container--pinned' : ''}`}
    >
      <span
        className={`crispy-cp-context ${colorClass}`}
        onClick={(e) => {
          e.stopPropagation();
          setPinned(!pinned);
        }}
      >
        💿 {percent}%
      </span>
      {pinned && (
        <div className="crispy-cp-context-tooltip">
          <div className="crispy-cp-context-tooltip__empty">No usage data yet</div>
        </div>
      )}
    </span>
  );
}
