/**
 * TitleBar — Minimal global chrome header
 *
 * Shows brand/logo, optional projects dropdown, CWD selector (websocket mode),
 * and theme toggle (dev server only). Per-tab controls (session selector,
 * panel toggles, connection dot) are in TabHeader.
 *
 * @module TitleBar
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { useEnvironment } from '../context/EnvironmentContext.js';
import { useThemeKind, isLightTheme } from '../hooks/useThemeKind.js';
import { ProjectsView } from './session-selector/index.js';
import { useAvailableCwds } from '../hooks/useAvailableCwds.js';
import { fsPathToUrlPath } from '../../core/url-path-resolver.js';
import { useTabControllerOptional } from '../context/TabControllerContext.js';
import { useGitInfo } from '../hooks/useGitInfo.js';
import { useConnectionState } from '../hooks/useConnectionState.js';
// esbuild --loader:.svg=text imports the raw SVG markup as a string
// @ts-expect-error — no type declarations for raw SVG import
import crispyLogoSvg from '../../../media/crispy-icon.svg';

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

/** Git branch icon — reused from TabHeader */
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

/** Connection status indicator — only visible when disconnected or reconnecting */
function ConnectionIndicator(): React.JSX.Element | null {
  const state = useConnectionState();
  if (state === 'connected' || state === 'connecting') return null;

  const isReconnecting = state === 'reconnecting';
  return (
    <div
      className={`crispy-titlebar__conn-status crispy-titlebar__conn-status--${state}`}
      title={isReconnecting ? 'Reconnecting to daemon...' : 'Disconnected from daemon'}
    >
      <span className={`crispy-titlebar__conn-dot crispy-titlebar__conn-dot--${state}`} />
      <span className="crispy-titlebar__conn-label">
        {isReconnecting ? 'Reconnecting...' : 'Disconnected'}
      </span>
    </div>
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

export function TitleBar(): React.JSX.Element {
  const { selectedCwd, setSelectedCwd } = useSession();
  const envKind = useEnvironment();
  const { rosieBotEnabled } = usePreferences();
  const tabController = useTabControllerOptional();
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const allCwds = useAvailableCwds();

  // In websocket mode with workspace routing, CWD changes navigate to the new URL
  const cwdMeta = document.querySelector('meta[name="crispy-cwd"]')?.getAttribute('content');
  const homeMeta = document.querySelector('meta[name="crispy-home"]')?.getAttribute('content');
  const handleCwdChange = useCallback((slug: string | null) => {
    if ((envKind === 'websocket' || envKind === 'tauri') && cwdMeta && slug) {
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

  const gitInfo = useGitInfo();

  const handleToggleGit = useCallback(() => {
    tabController?.toggleGitBorder();
  }, [tabController]);

  const handleToggleFiles = useCallback(() => {
    tabController?.toggleFilesBorder();
  }, [tabController]);

  const handleEqualizeLayout = useCallback(() => {
    tabController?.equalizeLayout();
  }, [tabController]);

  const toggleProjects = useCallback(() => {
    setProjectsOpen(prev => !prev);
  }, []);

  const handleProjectSelect = useCallback((sessionId: string) => {
    if (tabController) {
      tabController.navigateToSession(sessionId);
    }
    setTimeout(() => setProjectsOpen(false), 200);
  }, [tabController]);

  // Click-outside to close projects dropdown
  useEffect(() => {
    if (!projectsOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(target)) {
        setProjectsOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [projectsOpen]);

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

      {/* Projects dropdown */}
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

      {/* Connection status — only visible when disconnected/reconnecting */}
      {envKind === 'websocket' && <ConnectionIndicator />}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Right — Layout utilities, then content panel toggles */}
      <div className="crispy-titlebar__right">
        {envKind !== 'vscode' && (
          <button
            className="crispy-titlebar__btn"
            onClick={handleEqualizeLayout}
            title="Equalize tab widths (Alt+E)"
            aria-label="Equalize tab widths"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="1" y="3" width="3.5" height="10" rx="1" />
              <rect x="6.25" y="3" width="3.5" height="10" rx="1" />
              <rect x="11.5" y="3" width="3.5" height="10" rx="1" />
            </svg>
          </button>
        )}
        {envKind === 'websocket' && <ThemeToggle />}
        {envKind !== 'vscode' && (
          <>
            <span className="crispy-titlebar__group-sep" />
            <button
              className="crispy-titlebar__btn crispy-titlebar__files-btn"
              onClick={handleToggleFiles}
              title="Toggle Files panel (Alt+F)"
              aria-label="Toggle Files panel"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M2 2h5l2 2h5v10H2V2z" />
              </svg>
            </button>
            <button
              className="crispy-titlebar__btn crispy-titlebar__git-btn"
              onClick={handleToggleGit}
              title="Toggle Git panel (Alt+G)"
              aria-label="Toggle Git panel"
            >
              <GitBranchIcon />
              {gitInfo && (
                <span className="crispy-titlebar__git-label">
                  {gitInfo.branch}{gitInfo.dirty ? ' *' : ''}
                </span>
              )}
            </button>
          </>
        )}
      </div>
    </header>
  );
}
