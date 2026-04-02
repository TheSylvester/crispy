/**
 * TitleBar — Fixed header with session dropdown, CWD/status, and new-session button
 *
 * Two-section layout:
 *   Left:   Session dropdown button (label + animated chevron) — toggles sidebar,
 *           followed by connection indicator dot
 *   Right:  Tool panel toggle + New session button
 *
 * Connection dot shows streaming/idle/approval state with glow.
 * Click-to-copy session ID on the dot.
 *
 * @module TitleBar
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.js';
import { usePreferences, type SidebarView } from '../context/PreferencesContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';
import { useTransport } from '../context/TransportContext.js';
import { useEnvironment } from '../context/EnvironmentContext.js';
import { useThemeKind, isLightTheme } from '../hooks/useThemeKind.js';
import { SessionSelector, ProjectsView } from './session-selector/index.js';
import { useAvailableCwds } from '../hooks/useAvailableCwds.js';
import { fsPathToUrlPath } from '../../core/url-path-resolver.js';
import { useFilePanel } from '../context/FilePanelContext.js';
// esbuild --loader:.svg=text imports the raw SVG markup as a string
// @ts-expect-error — no type declarations for raw SVG import
import crispyLogoSvg from '../../../media/crispy-icon.svg';
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

/** Overlapping windows icon for "New Window" */
function WindowIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <path d="M1 9V2a1 1 0 0 1 1-1h7" />
    </svg>
  );
}

/** Crispy logo + wordmark + divider — brand presence in the titlebar */
function AppIcon(): React.JSX.Element {
  return (
    <div className="crispy-titlebar__brand">
      <div
        className="crispy-titlebar__app-icon"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: crispyLogoSvg }}
      />
      <span className="crispy-titlebar__wordmark">Crispy</span>
      <span className="crispy-titlebar__brand-sep" />
    </div>
  );
}

/** Git branch icon — stroke-based branch glyph (12px) */
function GitBranchIcon(): React.JSX.Element {
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
      <line x1="6" y1="3" x2="6" y2="13" />
      <circle cx="6" cy="3" r="2" />
      <circle cx="6" cy="13" r="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7c0 2-2 3-6 4" />
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

/** File-tree icon for the Files sidebar view */
function FilePanelIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <line x1="2" y1="3" x2="14" y2="3" />
      <line x1="5" y1="8" x2="14" y2="8" />
      <line x1="5" y1="13" x2="14" y2="13" />
    </svg>
  );
}

/** Clipboard-list icon for Projects */
function ProjectsIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="1" width="8" height="10" rx="1" />
      <line x1="4.5" y1="4" x2="8" y2="4" />
      <line x1="4.5" y1="6.5" x2="8" y2="6.5" />
      <line x1="4.5" y1="9" x2="7" y2="9" />
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
  const { sessions, selectedSessionId, setSelectedSessionId, selectedCwd, setSelectedCwd } = useSession();
  const transport = useTransport();
  const envKind = useEnvironment();
  const { sidebarCollapsed, setSidebarCollapsed, toolPanelOpen, setToolPanelOpen, sidebarView, setSidebarView, rosieBotEnabled } = usePreferences();
  const { fileViewerOpen, closeFile } = useFilePanel();
  const { channelState } = useSessionStatus(selectedSessionId);
  const dropdownContainerRef = useRef<HTMLDivElement>(null);
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const allCwds = useAvailableCwds();

  // In websocket mode with workspace routing, CWD changes navigate to the new URL
  const cwdMeta = document.querySelector('meta[name="crispy-cwd"]')?.getAttribute('content');
  const homeMeta = document.querySelector('meta[name="crispy-home"]')?.getAttribute('content');
  const handleCwdChange = useCallback((slug: string | null) => {
    if (envKind === 'websocket' && cwdMeta && slug) {
      const cwd = allCwds.find(c => c.slug === slug);
      if (cwd && homeMeta) {
        window.location.replace(fsPathToUrlPath(cwd.fullPath, homeMeta));
        return;
      }
    }
    setSelectedCwd(slug);
  }, [envKind, cwdMeta, homeMeta, allCwds, setSelectedCwd]);

  // Cap visible CWDs to keep the native dropdown manageable
  const MAX_CWDS = 15;
  const availableCwds = useMemo(() => {
    if (allCwds.length <= MAX_CWDS) return allCwds;
    const top = allCwds.slice(0, MAX_CWDS);
    if (selectedCwd && !top.some(c => c.slug === selectedCwd)) {
      const selected = allCwds.find(c => c.slug === selectedCwd);
      if (selected) top.push(selected);
    }
    return top;
  }, [allCwds, selectedCwd]);

  // Derive button label from current session — fall back to "Conversations"
  const currentSession = selectedSessionId
    ? sessions.find(s => s.sessionId === selectedSessionId)
    : null;
  const buttonLabel = currentSession
    ? truncateLabel(getSessionDisplayName(currentSession), BUTTON_LABEL_MAX)
    : 'Conversations';

  // Push session label to host tab title and document.title (all environments)
  const tabTitle = currentSession
    ? `${truncateLabel(getSessionDisplayName(currentSession), 70)} — Crispy`
    : 'Crispy';

  useEffect(() => {
    transport.postRaw?.({ kind: 'setTitle', title: tabTitle });
    document.title = tabTitle;
  }, [tabTitle, transport]);

  const toggleSidebar = useCallback(() => {
    setProjectsOpen(false);
    setSidebarCollapsed(!sidebarCollapsed);
  }, [sidebarCollapsed, setSidebarCollapsed]);

  const toggleProjects = useCallback(() => {
    setSidebarCollapsed(true);
    setProjectsOpen(prev => !prev);
  }, [setSidebarCollapsed]);

  const handleProjectSelect = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setTimeout(() => setProjectsOpen(false), 200);
  }, [setSelectedSessionId]);

  const handleNew = useCallback(() => {
    setSelectedSessionId(null);
    setNewMenuOpen(false);
  }, [setSelectedSessionId]);

  const isDesktop = !!(window as any).__CRISPY_DESKTOP__;

  const handleNewWindow = useCallback(() => {
    setNewMenuOpen(false);
    const ipc = (window as any).__TAURI_INTERNALS__;
    if (ipc) {
      // Tauri desktop — create a new native window
      ipc.invoke('create_window').catch(() => {});
    } else {
      // Browser / dev server — open a new tab
      window.open(window.location.href, '_blank');
    }
  }, []);

  const handleSidebarButton = useCallback((view: SidebarView) => {
    if (toolPanelOpen && sidebarView === view) {
      setToolPanelOpen(false);
    } else {
      setSidebarView(view);
      setToolPanelOpen(true);
    }
  }, [toolPanelOpen, sidebarView, setToolPanelOpen, setSidebarView]);

  // Listen for native menu actions dispatched via CustomEvent from Tauri init script
  useEffect(() => {
    const handler = (e: Event) => {
      const action = (e as CustomEvent).detail?.action;
      if (action === 'new_session') handleNew();
    };
    window.addEventListener('crispy-menu', handler);
    return () => window.removeEventListener('crispy-menu', handler);
  }, [handleNew]);

  // Alt+T / Alt+F keyboard shortcuts — toggle sidebar views
  useEffect(() => {
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
  }, [handleSidebarButton, fileViewerOpen, closeFile]);

  // Click-outside to close dropdowns
  useEffect(() => {
    if (sidebarCollapsed && !projectsOpen && !newMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!sidebarCollapsed &&
          dropdownContainerRef.current &&
          !dropdownContainerRef.current.contains(target)) {
        setSidebarCollapsed(true);
      }
      if (projectsOpen &&
          projectDropdownRef.current &&
          !projectDropdownRef.current.contains(target)) {
        setProjectsOpen(false);
      }
      if (newMenuOpen &&
          newMenuRef.current &&
          !newMenuRef.current.contains(target)) {
        setNewMenuOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [sidebarCollapsed, setSidebarCollapsed, projectsOpen, newMenuOpen]);

  return (
    <header className="crispy-titlebar">
      {/* App icon — click to return to workspace picker */}
      {envKind === 'websocket' ? (
        <button
          className="crispy-titlebar__brand-link"
          title="Switch workspace"
          onClick={() => {
            const ipc = (window as any).__TAURI_INTERNALS__;
            if (ipc) {
              // Tauri: let Rust navigate to the primary daemon's root
              ipc.invoke('switch_to_picker').catch(() => {
                window.location.href = '/';
              });
            } else {
              window.location.href = '/';
            }
          }}
        >
          <AppIcon />
        </button>
      ) : (
        <AppIcon />
      )}

      {/* Left — Projects + Conversations dropdowns share a positioning wrapper */}
      <div className="crispy-session-dropdown-container" ref={dropdownContainerRef}>
        {rosieBotEnabled && (
          <div className="crispy-project-dropdown-container" ref={projectDropdownRef}>
            <button
              className="crispy-titlebar__btn crispy-titlebar__projects-btn"
              onClick={toggleProjects}
              title="Projects"
              aria-label={projectsOpen ? 'Close projects' : 'Open projects'}
            >
              <ProjectsIcon />
              <Chevron open={projectsOpen} />
            </button>
            {projectsOpen && (
              <div className="crispy-session-dropdown">
                <ProjectsView
                  onSelectSession={handleProjectSelect}
                  availableCwds={availableCwds}
                  selectedCwd={selectedCwd}
                  onCwdChange={handleCwdChange}
                />
              </div>
            )}
          </div>
        )}
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

        {/* Connection indicator — right after Conversations button */}
        <ConnectionDot channelState={channelState} sessionId={selectedSessionId} />
      </div>

      {/* Right — Theme toggle (dev server only) + Git + Files + Tools + New button */}
      <div className="crispy-titlebar__right">
        {envKind === 'websocket' && <ThemeToggle />}
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
        <div className="crispy-titlebar__new-split" ref={newMenuRef}>
          <button
            className="crispy-titlebar__btn crispy-titlebar__new-btn"
            onClick={handleNew}
            title="New session"
          >
            <PlusIcon />
            <span className="crispy-titlebar__btn-label">New</span>
          </button>
          {(isDesktop || envKind === 'websocket') && (
            <>
              <button
                className="crispy-titlebar__btn crispy-titlebar__new-chevron"
                onClick={() => setNewMenuOpen(prev => !prev)}
                aria-label={newMenuOpen ? 'Close new menu' : 'Open new menu'}
                title="More options"
              >
                <Chevron open={newMenuOpen} />
              </button>
              {newMenuOpen && (
                <div className="crispy-titlebar__new-dropdown">
                  <button className="crispy-titlebar__new-dropdown-item" onClick={handleNew}>
                    <PlusIcon />
                    <span>New Session</span>
                    <span className="crispy-titlebar__new-dropdown-shortcut">
                      {navigator.platform.includes('Mac') ? '\u2318N' : 'Ctrl+N'}
                    </span>
                  </button>
                  <button className="crispy-titlebar__new-dropdown-item" onClick={handleNewWindow}>
                    <WindowIcon />
                    <span>New Window</span>
                    <span className="crispy-titlebar__new-dropdown-shortcut">
                      {navigator.platform.includes('Mac') ? '\u2318\u21E7N' : 'Ctrl+Shift+N'}
                    </span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </header>
  );
}
