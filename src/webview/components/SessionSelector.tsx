/**
 * Session Selector — sidebar session list
 *
 * Displays available sessions with vendor badge, project slug,
 * truncated ID, and relative time. Click to select.
 *
 * @module SessionSelector
 */

import { useSession } from '../context/SessionContext.js';

/**
 * Format an ISO date string as relative time: "5m ago", "2h ago", "3d ago"
 */
function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (isNaN(then)) return '';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function SessionSelector(): React.JSX.Element {
  const { sessions, selectedSessionId, setSelectedSessionId, isLoading, error } = useSession();

  if (isLoading) {
    return <div className="crispy-loading">Loading sessions...</div>;
  }

  if (error) {
    return <div className="crispy-error">{error}</div>;
  }

  if (sessions.length === 0) {
    return <div className="crispy-placeholder">No sessions found</div>;
  }

  return (
    <ul className="crispy-session-list">
      {sessions.map((session) => {
        const isSelected = session.sessionId === selectedSessionId;
        const className = `crispy-session-item${isSelected ? ' crispy-session-item--selected' : ''}`;

        return (
          <li
            key={session.sessionId}
            className={className}
            onClick={() => setSelectedSessionId(session.sessionId)}
          >
            <div>
              <span className="crispy-session-item__vendor">{session.vendor}</span>
              {session.projectSlug}
            </div>
            <div className="crispy-session-item__id">
              {session.sessionId.slice(0, 8)}…
            </div>
            <div className="crispy-session-item__time">
              {formatRelativeTime(session.modifiedAt)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
