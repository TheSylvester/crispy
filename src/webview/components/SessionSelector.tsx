/**
 * Session Selector — dropdown session list with search and CWD filtering
 *
 * Two-line layout per session: label (first message) on top,
 * last message preview below, with relative time on the right.
 *
 * Search filters by label + lastMessage with useDeferredValue for
 * responsive input. CWD filtering chains before search (Leto pattern).
 *
 * Renders as a headless list — positioning and portal mounting are the
 * caller's responsibility (see TranscriptHeader in FlexAppLayout).
 *
 * @module SessionSelector
 */

import { useState, useMemo, useDeferredValue } from 'react';
import { useSession } from '../context/SessionContext.js';

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

/**
 * Highlight first case-insensitive match of `query` within `text`.
 * Returns JSX fragments with <mark> around the match — no dangerouslySetInnerHTML.
 */
function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;

  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;

  return (
    <>
      {text.slice(0, idx)}
      <mark className="crispy-session-highlight">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function SessionSelector({
  onSelect,
  onClose,
}: {
  /** Called when the user picks a session. */
  onSelect: (sessionId: string) => void;
  /** Called after selection (or Escape) so the parent can close the dropdown. */
  onClose: () => void;
}): React.JSX.Element {
  const { sessions, selectedSessionId, selectedCwd, isLoading, error } =
    useSession();

  // All hooks unconditionally (fixes prior rules-of-hooks violation)
  const [showAll, setShowAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const deferredQuery = useDeferredValue(searchQuery);

  // Two-stage filter: CWD first, then search. Expose intermediate count
  // so the "match in all text" button knows if there could be more matches.
  const { filteredSessions, cwdFilteredCount } = useMemo(() => {
    let result = sessions;

    // Stage 1: CWD filter (when a specific project is selected)
    if (selectedCwd) {
      result = result.filter((s) => s.projectSlug === selectedCwd);
    }
    const cwdFilteredCount = result.length;

    // Stage 2: Search filter (case-insensitive on label + lastMessage)
    if (deferredQuery) {
      const q = deferredQuery.toLowerCase();
      result = result.filter((s) => {
        const labelMatch = s.label?.toLowerCase().includes(q) ?? false;
        const previewMatch = s.lastMessage?.toLowerCase().includes(q) ?? false;
        return labelMatch || previewMatch;
      });
    }

    return { filteredSessions: result, cwdFilteredCount };
  }, [sessions, selectedCwd, deferredQuery]);

  // Early returns AFTER all hooks
  if (isLoading) {
    return <div className="crispy-loading">Loading sessions...</div>;
  }
  if (error) {
    return <div className="crispy-error">{error}</div>;
  }
  if (sessions.length === 0) {
    return <div className="crispy-placeholder">No sessions found</div>;
  }

  const isSearching = deferredQuery.length > 0;

  // When searching, show all matches (bypass cap). Otherwise respect the cap.
  const visibleSessions =
    isSearching || showAll ? filteredSessions : filteredSessions.slice(0, INITIAL_RENDER_CAP);

  const hasMore = !isSearching && filteredSessions.length > INITIAL_RENDER_CAP && !showAll;
  const hasFullTextButton = isSearching && filteredSessions.length < cwdFilteredCount;

  return (
    <ul className="crispy-session-list">
      {/* Search input */}
      <li className="crispy-session-search">
        <input
          className="crispy-session-search__input"
          type="text"
          placeholder="Search conversations…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (searchQuery) setSearchQuery('');
              else onClose();
            }
          }}
        />
      </li>

      {/* Session items */}
      {visibleSessions.map((session) => {
        const isSelected = session.sessionId === selectedSessionId;
        const className = `crispy-session-item${isSelected ? ' crispy-session-item--selected' : ''}`;

        return (
          <li
            key={session.sessionId}
            className={className}
            onClick={() => {
              onSelect(session.sessionId);
              // Auto-close after selection (slight delay for visual feedback)
              setTimeout(onClose, 200);
            }}
          >
            <div className="crispy-session-item__header">
              <span className="crispy-session-item__label">
                {highlightMatch(
                  session.label || session.sessionId.slice(0, 8) + '\u2026',
                  deferredQuery,
                )}
              </span>
              <span className="crispy-session-item__time">
                {formatRelativeTime(session.modifiedAt)}
              </span>
            </div>
            {session.lastMessage && (
              <div className="crispy-session-item__preview">
                {highlightMatch(session.lastMessage, deferredQuery)}
              </div>
            )}
          </li>
        );
      })}

      {/* Empty state when searching */}
      {isSearching && filteredSessions.length === 0 && (
        <li className="crispy-session-item crispy-session-item--empty">
          <span className="crispy-session-item__label">No matches</span>
        </li>
      )}

      {/* Show more button (only when NOT searching) */}
      {hasMore && (
        <li
          className="crispy-session-item crispy-session-item--show-more"
          onClick={() => setShowAll(true)}
        >
          <span className="crispy-session-item__label">
            Show {filteredSessions.length - INITIAL_RENDER_CAP} more…
          </span>
        </li>
      )}

      {/* Match in all text — placeholder for future transcript grep */}
      {hasFullTextButton && (
        <li
          className="crispy-session-item crispy-session-item--full-text"
          onClick={() => {
            console.log(
              '[SessionSelector] Match in all text requested for query:',
              deferredQuery,
            );
          }}
        >
          <span className="crispy-session-item__label">Match in all text…</span>
        </li>
      )}
    </ul>
  );
}
