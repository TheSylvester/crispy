/**
 * TitleBar — Fixed header with session dropdown, CWD/status, and new-session button
 *
 * Three-column layout matching Leto webview-next:
 *   Left:   Session dropdown button (label + animated chevron) — toggles sidebar
 *   Center: CWD display (last 2 path segments, clickable) + connection indicator dot
 *   Right:  New session button
 *
 * Connection dot shows streaming/idle/approval state with Leto-style glow.
 * Click-to-copy session ID on the dot (Leto pattern).
 *
 * @module TitleBar
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../context/SessionContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';
import { useCwd } from '../hooks/useSessionCwd.js';
import { useAvailableCwds } from '../hooks/useAvailableCwds.js';

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
 * Click-to-copy session ID (Leto pattern: flash "copied" feedback).
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
    <span
      className={dotClass}
      title={title}
      onClick={handleCopy}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCopy(); }}
    />
  );
}

export function TitleBar(): React.JSX.Element {
  const { sessions, selectedSessionId, setSelectedSessionId, selectedCwd, setSelectedCwd } = useSession();
  const { sidebarCollapsed, setSidebarCollapsed, toolPanelOpen, setToolPanelOpen } = usePreferences();
  const { channelState } = useSessionStatus(selectedSessionId);
  const { fullPath } = useCwd();
  const allCwds = useAvailableCwds();

  /** Cap visible CWDs to keep the native dropdown manageable.
   *  Always includes the currently selected CWD even if it falls outside the cap. */
  const MAX_CWDS = 15;
  const availableCwds = useMemo(() => {
    if (allCwds.length <= MAX_CWDS) return allCwds;
    const top = allCwds.slice(0, MAX_CWDS);
    // Ensure selected CWD is always present
    if (selectedCwd && !top.some((c) => c.slug === selectedCwd)) {
      const selected = allCwds.find((c) => c.slug === selectedCwd);
      if (selected) top.push(selected);
    }
    return top;
  }, [allCwds, selectedCwd]);

  const sessionLabel =
    sessions.find((s) => s.sessionId === selectedSessionId)?.label ?? 'No session';

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  const handleNew = useCallback(() => {
    setSelectedSessionId(null);
    console.log('[TitleBar] New session requested — transport.createSession() not wired yet');
  }, [setSelectedSessionId]);

  const handleCwdChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedCwd(e.target.value || null);
  }, [setSelectedCwd]);

  const toggleToolPanel = useCallback(() => {
    setToolPanelOpen(!toolPanelOpen);
  }, [toolPanelOpen, setToolPanelOpen]);

  // Alt+T keyboard shortcut — toggle tool activity panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 't' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        setToolPanelOpen(!document.querySelector('[data-tool-panel="open"]'));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setToolPanelOpen]);

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

      {/* Center — CWD dropdown + connection indicator */}
      <div className="crispy-titlebar__center">
        {availableCwds.length > 0 && (
          <select
            className="crispy-titlebar__cwd-select"
            value={selectedCwd ?? ''}
            onChange={handleCwdChange}
            title={fullPath ?? 'All projects'}
          >
            <option value="">All Projects</option>
            {availableCwds.map((cwd) => (
              <option key={cwd.slug} value={cwd.slug} title={cwd.fullPath}>
                {cwd.display}
              </option>
            ))}
          </select>
        )}
        <ConnectionDot channelState={channelState} sessionId={selectedSessionId} />
      </div>

      {/* Right — Tool panel toggle + New button */}
      <div className="crispy-titlebar__right">
        <button
          className={`crispy-titlebar__btn crispy-titlebar__tool-panel-btn${toolPanelOpen ? ' crispy-titlebar__tool-panel-btn--active' : ''}`}
          onClick={toggleToolPanel}
          title="Toggle tool panel (Alt+T)"
          aria-label={toolPanelOpen ? 'Close tool panel' : 'Open tool panel'}
        >
          <ToolPanelIcon />
          <span>Tools</span>
        </button>
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
