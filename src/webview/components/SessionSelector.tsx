/**
 * Session Selector — sidebar session list
 *
 * Two-line layout per session: label (first message) on top,
 * last message preview below, with relative time on the right.
 *
 * @module SessionSelector
 */

import { useState } from 'react';
import { useSession } from '../context/SessionContext.js';
import { usePreferences } from '../context/PreferencesContext.js';

/** Number of sessions to render initially before "Show more" */
const INITIAL_RENDER_CAP = 30;

/**
 * Format an ISO date string as compact relative time: "now", "5m", "3h", "2d"
 */
function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (isNaN(then)) return '';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;

  const years = Math.floor(days / 365);
  return `${years}y`;
}

export function SessionSelector(): React.JSX.Element {
  const { sessions, selectedSessionId, setSelectedSessionId, isLoading, error } = useSession();
  const { setSidebarCollapsed } = usePreferences();

  if (isLoading) {
    return <div className="crispy-loading">Loading sessions...</div>;
  }

  if (error) {
    return <div className="crispy-error">{error}</div>;
  }

  const [showAll, setShowAll] = useState(false);

  if (sessions.length === 0) {
    return <div className="crispy-placeholder">No sessions found</div>;
  }

  const visibleSessions = showAll ? sessions : sessions.slice(0, INITIAL_RENDER_CAP);
  const hasMore = sessions.length > INITIAL_RENDER_CAP && !showAll;

  return (
    <ul className="crispy-session-list">
      {visibleSessions.map((session) => {
        const isSelected = session.sessionId === selectedSessionId;
        const className = `crispy-session-item${isSelected ? ' crispy-session-item--selected' : ''}`;

        return (
          <li
            key={session.sessionId}
            className={className}
            onClick={() => {
              setSelectedSessionId(session.sessionId);
              // Auto-collapse after selection (slight delay for visual feedback)
              setTimeout(() => setSidebarCollapsed(true), 200);
            }}
          >
            <div className="crispy-session-item__header">
              <span className="crispy-session-item__label">
                {session.label || session.sessionId.slice(0, 8) + '\u2026'}
              </span>
              <span className="crispy-session-item__time">
                {formatRelativeTime(session.modifiedAt)}
              </span>
            </div>
            {session.lastMessage && (
              <div className="crispy-session-item__preview">
                {session.lastMessage}
              </div>
            )}
          </li>
        );
      })}
      {hasMore && (
        <li
          className="crispy-session-item crispy-session-item--show-more"
          onClick={() => setShowAll(true)}
        >
          <span className="crispy-session-item__label">
            Show {sessions.length - INITIAL_RENDER_CAP} more…
          </span>
        </li>
      )}
    </ul>
  );
}
