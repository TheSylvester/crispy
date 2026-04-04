/**
 * TabHeader — per-tab header with session selector, panel toggles, and new button
 *
 * Renders inside each FlexLayout tab, below the global TitleBar. Contains
 * all the per-tab controls that were previously in TitleBar and bridged
 * through ActiveTabPanelBridge.
 *
 * @module TabHeader
 */

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useSession } from '../context/SessionContext.js';
import { useTabSession } from '../context/TabSessionContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { useTabPanel, type SidebarView } from '../context/TabPanelContext.js';
import { useFilePanel } from '../context/FilePanelContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';
import { useTabControllerOptional } from '../context/TabControllerContext.js';
import { useIsActiveTab } from '../context/TabContainerContext.js';
import { SessionSelector } from './session-selector/index.js';
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

function GitBranchIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="13" />
      <circle cx="6" cy="3" r="2" />
      <circle cx="6" cy="13" r="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7c0 2-2 3-6 4" />
    </svg>
  );
}

function FilePanelIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="2" y1="3" x2="14" y2="3" />
      <line x1="5" y1="8" x2="14" y2="8" />
      <line x1="5" y1="13" x2="14" y2="13" />
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
  const { sidebarCollapsed, setSidebarCollapsed } = usePreferences();
  const { toolPanelOpen, setToolPanelOpen, sidebarView, setSidebarView } = useTabPanel();
  const { fileViewerOpen, closeFile } = useFilePanel();
  const { channelState } = useSessionStatus(effectiveSessionId);
  const tabController = useTabControllerOptional();
  const isActiveTab = useIsActiveTab();
  const dropdownContainerRef = useRef<HTMLDivElement>(null);

  const currentSession = effectiveSessionId
    ? sessions.find(s => s.sessionId === effectiveSessionId)
    : null;
  const buttonLabel = currentSession
    ? truncateLabel(getSessionDisplayName(currentSession), BUTTON_LABEL_MAX)
    : 'Conversations';

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  const handleNew = useCallback(() => {
    if (tabController) {
      tabController.createTab();
    } else {
      setSelectedSessionId(null);
    }
  }, [tabController, setSelectedSessionId]);

  const handleSidebarButton = useCallback((view: SidebarView) => {
    if (toolPanelOpen && sidebarView === view) {
      setToolPanelOpen(false);
    } else {
      setSidebarView(view);
      setToolPanelOpen(true);
    }
  }, [toolPanelOpen, sidebarView, setToolPanelOpen, setSidebarView]);

  // Alt+T / Alt+F / Alt+G keyboard shortcuts — per-tab panel toggles
  useEffect(() => {
    if (!isActiveTab) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 't') {
          e.preventDefault();
          handleSidebarButton('tools');
        } else if (key === 'f') {
          e.preventDefault();
          handleSidebarButton('files');
        } else if (key === 'g') {
          e.preventDefault();
          handleSidebarButton('git');
        } else if (key === 'v') {
          e.preventDefault();
          if (fileViewerOpen) closeFile();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActiveTab, handleSidebarButton, fileViewerOpen, closeFile]);

  // Click-outside to close session dropdown
  useEffect(() => {
    if (sidebarCollapsed) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (dropdownContainerRef.current && !dropdownContainerRef.current.contains(target)) {
        setSidebarCollapsed(true);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  return (
    <div className="crispy-tab-header">
      {/* Left — Session selector + connection dot */}
      <div className="crispy-tab-header__left" ref={dropdownContainerRef}>
        <button
          className="crispy-titlebar__btn crispy-titlebar__session-btn"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? 'Open sessions' : 'Close sessions'}
          title={currentSession?.title || 'Toggle session list'}
        >
          <span className="crispy-titlebar__label">{buttonLabel}</span>
          <Chevron open={!sidebarCollapsed} />
        </button>
        {!sidebarCollapsed && (
          <div className="crispy-session-dropdown">
            <SessionSelector />
          </div>
        )}
        <ConnectionDot channelState={channelState} sessionId={effectiveSessionId} />
      </div>

      {/* Right — Git + Files + Tools + New */}
      <div className="crispy-tab-header__right">
        <button
          className={`crispy-titlebar__btn crispy-titlebar__sidebar-btn${toolPanelOpen && sidebarView === 'git' ? ' crispy-titlebar__sidebar-btn--active' : ''}`}
          onClick={() => handleSidebarButton('git')}
          title="Toggle git panel (Alt+G)"
          aria-label={toolPanelOpen && sidebarView === 'git' ? 'Close git panel' : 'Open git panel'}
        >
          <GitBranchIcon />
          <span className="crispy-titlebar__btn-label">Git</span>
        </button>
        <button
          className={`crispy-titlebar__btn crispy-titlebar__sidebar-btn${toolPanelOpen && sidebarView === 'files' ? ' crispy-titlebar__sidebar-btn--active' : ''}`}
          onClick={() => handleSidebarButton('files')}
          title="Toggle file panel (Alt+F)"
          aria-label={toolPanelOpen && sidebarView === 'files' ? 'Close file panel' : 'Open file panel'}
        >
          <FilePanelIcon />
          <span className="crispy-titlebar__btn-label">Files</span>
        </button>
        <button
          className={`crispy-titlebar__btn crispy-titlebar__sidebar-btn${toolPanelOpen && sidebarView === 'tools' ? ' crispy-titlebar__sidebar-btn--active' : ''}`}
          onClick={() => handleSidebarButton('tools')}
          title="Toggle tool panel (Alt+T)"
          aria-label={toolPanelOpen && sidebarView === 'tools' ? 'Close tool panel' : 'Open tool panel'}
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
