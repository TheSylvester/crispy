/**
 * TitleBar — Fixed header with session dropdown, CWD/status, and new-session button
 *
 * Three-column layout:
 *   Left:   Session dropdown button (label + animated chevron) — toggles sidebar,
 *           followed by connection indicator dot
 *   Center: Spacer
 *   Right:  Tool panel toggle + New session button
 *
 * Connection dot shows streaming/idle/approval state with glow.
 * Click-to-copy session ID on the dot.
 *
 * @module TitleBar
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';
import { useTransport } from '../context/TransportContext.js';
import { useEnvironment } from '../context/EnvironmentContext.js';
import { useThemeKind, isLightTheme } from '../hooks/useThemeKind.js';
import { SessionSelector } from './session-selector/index.js';
import { getSessionDisplayName } from '../utils/session-display.js';

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

/** Sun/Moon toggle — dev server only. Flips data-vscode-theme-kind on <body>. */
function ThemeToggle(): React.JSX.Element {
  const kind = useThemeKind();
  const light = isLightTheme(kind);

  const toggle = useCallback(() => {
    document.body.dataset.vscodeThemeKind = light ? 'vscode-dark' : 'vscode-light';
  }, [light]);

  return (
    <button
      className="crispy-titlebar__btn"
      onClick={toggle}
      title={`Switch to ${light ? 'dark' : 'light'} theme`}
      aria-label={`Switch to ${light ? 'dark' : 'light'} theme`}
    >
      {light ? (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1A.5.5 0 0 1 8 1zm0 11a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1A.5.5 0 0 1 8 12zm7-4a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1 0-1h1a.5.5 0 0 1 .5.5zM4 8a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1 0-1h1A.5.5 0 0 1 4 8zm9.1-3.7a.5.5 0 0 1 0 .7l-.7.7a.5.5 0 1 1-.7-.7l.7-.7a.5.5 0 0 1 .7 0zM4.3 12.3a.5.5 0 0 1 0 .7l-.7.7a.5.5 0 1 1-.7-.7l.7-.7a.5.5 0 0 1 .7 0zm9.4 0l-.7.7a.5.5 0 1 1-.7-.7l.7-.7a.5.5 0 0 1 .7.7zM4.3 3.7l-.7.7a.5.5 0 0 1-.7-.7l.7-.7a.5.5 0 0 1 .7.7zM8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6 .278a.768.768 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.35 8.35 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"/>
        </svg>
      )}
    </button>
  );
}

/** Wrench icon for the Tool Panel toggle */
function ToolPanelIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.5a4 4 0 0 0-4.7-3.2 4 4 0 0 0-2.8 5.3l-5.4 5.4 1.4 1.4 5.4-5.4a4 4 0 0 0 5.3-2.8l-2.3-2.3-1.5 1.5-1.4-1.4 1.5-1.5z" />
    </svg>
  );
}

/**
 * Connection indicator — 8px dot with state-driven color + glow.
 * Click-to-copy session ID (flash "copied" feedback).
 */
function ConnectionDot({
  channelState,
  sessionId,
}: {
  channelState: string | null;
  sessionId: string | null;
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);

  // Only show dot when a session is selected and has a known state
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
      console.error('[TitleBar] Failed to copy session ID');
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

/** Max characters for the session label shown in the dropdown button */
const BUTTON_LABEL_MAX = 64;

function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '\u2026';
}

export function TitleBar(): React.JSX.Element {
  const { sessions, selectedSessionId, setSelectedSessionId } = useSession();
  const { sidebarCollapsed, setSidebarCollapsed, toolPanelOpen, setToolPanelOpen } = usePreferences();
  const { channelState } = useSessionStatus(selectedSessionId);
  const dropdownContainerRef = useRef<HTMLDivElement>(null);

  // Derive button label from current session — fall back to "Conversations"
  const currentSession = selectedSessionId
    ? sessions.find(s => s.sessionId === selectedSessionId)
    : null;
  const buttonLabel = currentSession
    ? truncateLabel(getSessionDisplayName(currentSession), BUTTON_LABEL_MAX)
    : 'Conversations';

  // Push session label to host tab title
  const transport = useTransport();
  const envKind = useEnvironment();

  const TAB_TITLE_MAX = 24;
  const tabTitle = currentSession
    ? truncateLabel(getSessionDisplayName(currentSession), TAB_TITLE_MAX)
    : 'Crispy';

  useEffect(() => {
    transport.postRaw?.({ kind: 'setTitle', title: tabTitle });
    if (envKind === 'websocket') {
      document.title = tabTitle;
    }
  }, [tabTitle, transport, envKind]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  const handleNew = useCallback(() => {
    setSelectedSessionId(null);
  }, [setSelectedSessionId]);

  const toggleToolPanel = useCallback(() => {
    setToolPanelOpen(!toolPanelOpen);
  }, [toolPanelOpen, setToolPanelOpen]);

  // Alt+T keyboard shortcut — toggle tool activity panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        if (e.key.toLowerCase() === 't') {
          e.preventDefault();
          setToolPanelOpen(!document.querySelector('[data-tool-panel="open"]'));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setToolPanelOpen]);

  // Click-outside to close dropdown
  useEffect(() => {
    if (sidebarCollapsed) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownContainerRef.current &&
          !dropdownContainerRef.current.contains(e.target as Node)) {
        setSidebarCollapsed(true);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  return (
    <header className="crispy-titlebar">
      {/* Left — session dropdown toggle + anchored dropdown */}
      <div className="crispy-session-dropdown-container" ref={dropdownContainerRef}>
        <button
          className="crispy-titlebar__btn crispy-titlebar__session-btn"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Open sessions' : 'Close sessions'}
          title={currentSession?.quest || 'Toggle session list'}
        >
          <span className="crispy-titlebar__label">{buttonLabel}</span>
          <Chevron open={!sidebarCollapsed} />
        </button>
        {!sidebarCollapsed && (
          <div className="crispy-session-dropdown">
            <SessionSelector />
          </div>
        )}
      </div>

      {/* Connection indicator — right after Conversations button */}
      <ConnectionDot channelState={channelState} sessionId={selectedSessionId} />

      {/* Spacer pushes right section to the end */}
      <div className="crispy-titlebar__center" />

      {/* Right — Theme toggle (dev server only) + Tool panel toggle + New button */}
      <div className="crispy-titlebar__right">
        {envKind === 'websocket' && <ThemeToggle />}
        <button
          className={`crispy-titlebar__btn crispy-titlebar__tool-panel-btn${toolPanelOpen ? ' crispy-titlebar__tool-panel-btn--active' : ''}`}
          onClick={toggleToolPanel}
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
    </header>
  );
}
