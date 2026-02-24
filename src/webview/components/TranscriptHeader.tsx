/**
 * TranscriptHeader — per-tab session dropdown, connection dot, + new-session button.
 *
 * Lives inside the transcript tab, above the scroll area.
 * The dropdown is local to this tab — each tab manages its own open/close
 * state and renders the SessionSelector via a portal anchored to the button.
 * The ConnectionDot shows this tab's session channel state independently.
 *
 * @module TranscriptHeader
 */

import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from '../context/SessionContext.js';
import { useChannelState } from '../hooks/useChannelStore.js';
import { SessionSelector } from './SessionSelector.js';
import { ConnectionDot } from './ConnectionDot.js';

// ============================================================================
// Private helper components
// ============================================================================

/** SVG chevron — points down, rotates 180° when sidebar is open */
function Chevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      className={`crispy-transcript-header__chevron${open ? ' crispy-transcript-header__chevron--open' : ''}`}
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

/** Plus icon for the New button */
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

// ============================================================================
// TranscriptHeader
// ============================================================================

export function TranscriptHeader({
  onNewSession,
  onSelectSession,
  sessionId: headerSessionId,
}: {
  onNewSession: () => void;
  /** Called when a session is picked from the dropdown. */
  onSelectSession: (sessionId: string) => void;
  /** Per-tab session ID for label lookup + connection dot state. */
  sessionId: string | null;
}): React.JSX.Element {
  const { sessions } = useSession();
  const { channelState } = useChannelState(headerSessionId);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const sessionLabel =
    sessions.find((s) => s.sessionId === headerSessionId)?.label ?? 'No session';

  // --- Position the dropdown below the button ---
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!dropdownOpen || !buttonRef.current) {
      setPos(null);
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [dropdownOpen]);

  // --- Click-outside to close ---
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [dropdownOpen]);

  // --- Escape to close ---
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownOpen(false);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [dropdownOpen]);

  const handleClose = useCallback(() => setDropdownOpen(false), []);
  const handleSelect = useCallback(
    (sessionId: string) => {
      onSelectSession(sessionId);
    },
    [onSelectSession],
  );

  return (
    <div className="crispy-transcript-header">
      <button
        ref={buttonRef}
        className={`crispy-transcript-header__btn crispy-transcript-header__session-btn${dropdownOpen ? ' crispy-transcript-header__session-btn--open' : ''}`}
        onClick={() => setDropdownOpen((prev) => !prev)}
        aria-label={dropdownOpen ? 'Close sessions' : 'Open sessions'}
        aria-expanded={dropdownOpen}
        title="Toggle session list"
      >
        <span className="crispy-transcript-header__label">{sessionLabel}</span>
        <Chevron open={dropdownOpen} />
      </button>

      {dropdownOpen &&
        pos &&
        createPortal(
          <>
            <div
              className="crispy-session-dropdown-backdrop"
              onClick={handleClose}
              aria-hidden="true"
            />
            <div
              ref={dropdownRef}
              className="crispy-session-dropdown"
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="crispy-session-dropdown__header">Sessions</div>
              <SessionSelector onSelect={handleSelect} onClose={handleClose} selectedSessionId={headerSessionId} />
            </div>
          </>,
          document.body,
        )}

      <ConnectionDot channelState={channelState} sessionId={headerSessionId} />

      <button
        className="crispy-transcript-header__btn crispy-transcript-header__new-btn"
        onClick={onNewSession}
        title="New session"
      >
        <PlusIcon />
        <span>New</span>
      </button>
    </div>
  );
}
