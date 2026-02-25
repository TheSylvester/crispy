/**
 * Context Widget — percentage display with tooltip
 *
 * Shows context usage as "💿 42%" with color-coded percentage.
 * Click toggles a pinned tooltip with token breakdown. Click-outside closes.
 *
 * @module control-panel/ContextWidget
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ContextUsage } from '../../../core/transcript.js';

interface ContextWidgetProps {
  percent: number;
  contextUsage?: ContextUsage | null;
  /** Hide emoji prefix in narrow layouts. */
  compact?: boolean;
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

/** Format a number with comma separators (e.g., 123456 → "123,456"). */
function formatTokens(n: number): string {
  return n.toLocaleString();
}

/** Format a USD cost (e.g., 0.0234 → "$0.0234"). */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function ContextWidget({ percent, contextUsage, compact }: ContextWidgetProps): React.JSX.Element {
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
        {!compact && '💿 '}{percent}%
      </span>
      {pinned && (
        <div className="crispy-cp-context-tooltip">
          {contextUsage ? (
            <>
              <div className="crispy-cp-context-tooltip__row">
                <span>Input</span>
                <span>{formatTokens(contextUsage.tokens.input)}</span>
              </div>
              <div className="crispy-cp-context-tooltip__row">
                <span>Output</span>
                <span>{formatTokens(contextUsage.tokens.output)}</span>
              </div>
              <div className="crispy-cp-context-tooltip__row">
                <span>Cache Write</span>
                <span>{formatTokens(contextUsage.tokens.cacheCreation)}</span>
              </div>
              <div className="crispy-cp-context-tooltip__row">
                <span>Cache Read</span>
                <span>{formatTokens(contextUsage.tokens.cacheRead)}</span>
              </div>
              <div className="crispy-cp-context-tooltip__divider" />
              <div className="crispy-cp-context-tooltip__row crispy-cp-context-tooltip__row--total">
                <span>Total</span>
                <span>{formatTokens(contextUsage.totalTokens)} / {formatTokens(contextUsage.contextWindow)}</span>
              </div>
              {contextUsage.totalCostUsd !== undefined && (
                <div className="crispy-cp-context-tooltip__row">
                  <span>Cost</span>
                  <span>{formatCost(contextUsage.totalCostUsd)}</span>
                </div>
              )}
            </>
          ) : (
            <div className="crispy-cp-context-tooltip__empty">No usage data yet</div>
          )}
        </div>
      )}
    </span>
  );
}
