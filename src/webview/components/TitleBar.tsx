/**
 * TitleBar — Fixed header with session dropdown, status dot, and new-session button
 *
 * Left:   Session dropdown button (label + animated chevron) — toggles sidebar
 * Center: Empty structural slot for future CWD/git display
 * Right:  Connection dot (streaming/idle/approval) + New session button
 *
 * @module TitleBar
 */

import { useCallback } from 'react';
import { useSession } from '../context/SessionContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';

/** SVG chevron — points down, rotates 180° when sidebar is open */
function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      className={`crispy-titlebar__chevron${open ? ' crispy-titlebar__chevron--open' : ''}`}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3,4.5 6,7.5 9,4.5" />
    </svg>
  );
}

/** Plus icon for the New button — matches Leto webview-next sizing */
function PlusIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M6 2V10M2 6H10" />
    </svg>
  );
}

export function TitleBar(): React.JSX.Element {
  const { sessions, selectedSessionId, setSelectedSessionId } = useSession();
  const { sidebarCollapsed, setSidebarCollapsed } = usePreferences();
  const { channelState } = useSessionStatus(selectedSessionId);

  const sessionLabel =
    sessions.find((s) => s.sessionId === selectedSessionId)?.label ?? 'No session';

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  const handleNew = useCallback(() => {
    setSelectedSessionId(null);
    console.log('[TitleBar] New session requested — transport.createSession() not wired yet');
  }, [setSelectedSessionId]);

  // Dot class based on channel state
  const dotClass =
    channelState === 'streaming'
      ? 'crispy-titlebar__dot crispy-titlebar__dot--streaming'
      : channelState === 'idle'
        ? 'crispy-titlebar__dot crispy-titlebar__dot--idle'
        : channelState === 'awaiting_approval'
          ? 'crispy-titlebar__dot crispy-titlebar__dot--approval'
          : null; // hidden for null / unattached

  return (
    <header className="crispy-titlebar">
      {/* Left — session dropdown toggle */}
      <button
        className="crispy-titlebar__btn crispy-titlebar__session-btn"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? 'Open sessions' : 'Close sessions'}
        title="Toggle session list"
      >
        <span className="crispy-titlebar__label">{sessionLabel}</span>
        <Chevron open={!sidebarCollapsed} />
      </button>

      {/* Center — structural slot for CWD / git (future) */}
      <div className="crispy-titlebar__center" />

      {/* Right — connection dot + New button */}
      <div className="crispy-titlebar__right">
        {dotClass && (
          <span className={dotClass} title={`Status: ${channelState}`} />
        )}
        <button
          className="crispy-titlebar__btn crispy-titlebar__new-btn"
          onClick={handleNew}
          title="New session"
        >
          <PlusIcon />
          <span>New</span>
        </button>
      </div>
    </header>
  );
}
