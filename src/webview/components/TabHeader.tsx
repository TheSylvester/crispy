/**
 * TabHeader — per-tab header with session selector, panel toggles, and new button
 *
 * Renders inside each FlexLayout tab, below the global TitleBar. Contains
 * all the per-tab controls that were previously in TitleBar and bridged
 * through ActiveTabPanelBridge.
 *
 * @module TabHeader
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.js';
import { useTabSession } from '../context/TabSessionContext.js';
import { useTabPanel } from '../context/TabPanelContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';
import { useTabControllerOptional } from '../context/TabControllerContext.js';
import { useIsActiveTab } from '../context/TabContainerContext.js';
import { SessionSelector } from './session-selector/index.js';
import { useTransport } from '../context/TransportContext.js';
import { getSessionDisplayName } from '../utils/session-display.js';

// ============================================================================
// Inline SVG icons (same as TitleBar — will be shared later)
// ============================================================================

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

function PlusIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6 2V10M2 6H10" />
    </svg>
  );
}

function ToolPanelIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.5a4 4 0 0 0-4.7-3.2 4 4 0 0 0-2.8 5.3l-5.4 5.4 1.4 1.4 5.4-5.4a4 4 0 0 0 5.3-2.8l-2.3-2.3-1.5 1.5-1.4-1.4 1.5-1.5z" />
    </svg>
  );
}

/** Connection indicator dot — same as TitleBar's ConnectionDot */
function ConnectionDot({
  channelState,
  sessionId,
}: {
  channelState: string | null;
  sessionId: string | null;
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);

  const dotModifier =
    channelState === 'streaming'
      ? 'crispy-titlebar__dot--streaming'
      : channelState === 'idle'
        ? 'crispy-titlebar__dot--idle'
        : channelState === 'awaiting_approval'
          ? 'crispy-titlebar__dot--approval'
          : channelState === 'background'
            ? 'crispy-titlebar__dot--background'
            : null;

  if (!dotModifier) return null;

  const dotClass = `crispy-titlebar__dot ${dotModifier}${copied ? ' crispy-titlebar__dot--copied' : ''}`;

  const handleCopy = async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      console.error('[TabHeader] Failed to copy session ID');
    }
  };

  const title = copied
    ? 'Copied!'
    : sessionId
      ? `${channelState} · click to copy session ID`
      : `Status: ${channelState}`;

  return (
    <span className="crispy-titlebar__dot-wrapper">
      <span
        className={dotClass}
        title={title}
        onClick={handleCopy}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCopy(); }}
      />
      {copied && sessionId && (
        <span className="crispy-titlebar__dot-copied-label">
          Copied <span className="crispy-titlebar__dot-copied-id">{sessionId.slice(0, 8)}</span>
        </span>
      )}
    </span>
  );
}

// ============================================================================
// TabHeader
// ============================================================================

const BUTTON_LABEL_MAX = 64;

function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '\u2026';
}

export function TabHeader(): React.JSX.Element {
  const { sessions } = useSession();
  const { effectiveSessionId, setSelectedSessionId } = useTabSession();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const { toolPanelOpen, setToolPanelOpen } = useTabPanel();
  const { channelState } = useSessionStatus(effectiveSessionId);
  const tabController = useTabControllerOptional();
  const isActiveTab = useIsActiveTab();
  const transport = useTransport();
  const dropdownContainerRef = useRef<HTMLDivElement>(null);

  const currentSession = useMemo(
    () => (effectiveSessionId
      ? sessions.find(s => s.sessionId === effectiveSessionId) ?? null
      : null),
    [effectiveSessionId, sessions],
  );
  const buttonLabel = useMemo(
    () => currentSession
      ? truncateLabel(getSessionDisplayName(currentSession), BUTTON_LABEL_MAX)
      : 'Conversations',
    [currentSession],
  );

  const toggleDropdown = useCallback(() => {
    setDropdownOpen(open => !open);
  }, []);

  const handleNew = useCallback(() => {
    setSelectedSessionId(null);
  }, [setSelectedSessionId]);

  // Alt+T / Alt+F / Alt+G keyboard shortcuts — per-tab panel toggles
  useEffect(() => {
    if (!isActiveTab) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 't') {
          e.preventDefault();
          setToolPanelOpen(!toolPanelOpen);
        } else if (key === 'f') {
          e.preventDefault();
          tabController?.toggleFilesBorder();
        } else if (key === 'g') {
          e.preventDefault();
          tabController?.toggleGitBorder();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActiveTab, toolPanelOpen, setToolPanelOpen, tabController]);

  // Update document.title and VS Code editor tab when active tab's session changes
  useEffect(() => {
    if (!isActiveTab) return;
    const label = currentSession
      ? `${truncateLabel(getSessionDisplayName(currentSession), 70)} — Crispy`
      : 'Crispy';
    document.title = label;
    transport.postRaw?.({ kind: 'setTitle', title: label });
  }, [isActiveTab, currentSession, transport]);

  // Click-outside to close session dropdown
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (dropdownContainerRef.current && !dropdownContainerRef.current.contains(target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [dropdownOpen]);

  return (
    <div className="crispy-tab-header">
      {/* Left — Session selector + connection dot */}
      <div className="crispy-tab-header__left" ref={dropdownContainerRef}>
        <button
          className="crispy-titlebar__btn crispy-titlebar__session-btn"
          onClick={toggleDropdown}
          aria-label={dropdownOpen ? 'Close sessions' : 'Open sessions'}
          title={currentSession?.title || 'Toggle session list'}
        >
          <span className="crispy-titlebar__label">{buttonLabel}</span>
          <Chevron open={dropdownOpen} />
        </button>
        {dropdownOpen && (
          <div className="crispy-session-dropdown">
            <SessionSelector onSelect={setSelectedSessionId} onClose={() => setDropdownOpen(false)} />
          </div>
        )}
        <ConnectionDot channelState={channelState} sessionId={effectiveSessionId} />
      </div>

      {/* Right — Tools + New */}
      <div className="crispy-tab-header__right">
        <button
          className={`crispy-titlebar__btn crispy-titlebar__sidebar-btn${toolPanelOpen ? ' crispy-titlebar__sidebar-btn--active' : ''}`}
          onClick={() => setToolPanelOpen(!toolPanelOpen)}
          title="Toggle tool panel (Alt+T)"
          aria-label={toolPanelOpen ? 'Close tool panel' : 'Open tool panel'}
        >
          <ToolPanelIcon />
          <span className="crispy-titlebar__btn-label">Tools</span>
        </button>
        <button
          className="crispy-titlebar__btn crispy-titlebar__new-btn"
          onClick={handleNew}
          title="New session"
        >
          <PlusIcon />
          <span className="crispy-titlebar__btn-label">New</span>
        </button>
      </div>
    </div>
  );
}
