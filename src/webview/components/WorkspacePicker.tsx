/**
 * WorkspacePicker — root page workspace selector
 *
 * Shown at `/` when no workspace CWD is set (websocket mode, no meta tag).
 * Lists known workspaces and provides an "Add folder" input.
 *
 * @module WorkspacePicker
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTransport } from '../context/TransportContext.js';
import { fsPathToUrlPath } from '../../core/url-path-resolver.js';
import { formatCwd } from '../hooks/useSessionCwd.js';
import type { WorkspaceInfo } from '../../core/workspace-roots.js';
import { animatedLogoSvg } from '../utils/animated-logo.js';

/** Format a timestamp as a human-readable relative time for workspace recency. */
function formatWorkspaceTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
  return new Date(epochMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const ARCHIVE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ---- WSL Install Card ----

type WslInstallState = 'idle' | 'installing' | 'success' | 'failed';

function WslInstallCard({
  distro,
  onDismiss,
  onInstallComplete,
}: {
  distro: string;
  onDismiss: () => void;
  onInstallComplete: () => void;
}): React.JSX.Element {
  const [state, setState] = useState<WslInstallState>('idle');
  const [output, setOutput] = useState('');
  const [showLog, setShowLog] = useState(false);

  const handleInstall = useCallback(async () => {
    setState('installing');
    setOutput('');
    try {
      const ipc = (window as any).__TAURI_INTERNALS__;
      if (!ipc) throw new Error('Not running in Tauri desktop');
      const result = await ipc.invoke('install_crispy_in_wsl', { distro });
      setOutput(result);
      setState('success');
      setTimeout(() => onInstallComplete(), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setOutput(msg);
      setState('failed');
    }
  }, [distro, onInstallComplete]);

  return (
    <div className="crispy-wsl-install-card">
      <button
        className="crispy-wsl-install-card__dismiss"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss WSL install card"
      >
        &times;
      </button>

      <div className="crispy-wsl-install-card__title">
        WSL detected ({distro})
      </div>

      {state === 'idle' && (
        <>
          <p className="crispy-wsl-install-card__desc">
            Install crispy-code in WSL to see Linux sessions alongside Windows ones.
          </p>
          <button className="crispy-wsl-install-card__action" onClick={handleInstall}>
            Install in WSL
          </button>
        </>
      )}

      {state === 'installing' && (
        <p className="crispy-wsl-install-card__desc">
          Installing to ~/.crispy/... this may take a minute.
        </p>
      )}

      {state === 'success' && (
        <p className="crispy-wsl-install-card__desc crispy-wsl-install-card__desc--success">
          crispy-code installed in WSL ({distro}). Restart Crispy to connect.
        </p>
      )}

      {state === 'failed' && (
        <>
          <p className="crispy-wsl-install-card__desc crispy-wsl-install-card__desc--error">
            Install failed. Check that Node.js is installed in WSL.
          </p>
          <div className="crispy-wsl-install-card__actions">
            {showLog && (
              <pre className="crispy-wsl-install-card__log">{output}</pre>
            )}
            <button
              className="crispy-wsl-install-card__action crispy-wsl-install-card__action--secondary"
              onClick={() => setShowLog(!showLog)}
            >
              {showLog ? 'Hide Log' : 'View Log'}
            </button>
            <button className="crispy-wsl-install-card__action" onClick={handleInstall}>
              Retry
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Workspace List with pinning, filtering, recency ----

function WorkspaceList({
  workspaces, pinnedPaths, filter, showArchived,
  onNavigate, onRemove, onTogglePin, onFilterChange, onShowArchived,
  newPath, onNewPathChange, onAdd,
}: {
  workspaces: WorkspaceInfo[];
  pinnedPaths: Set<string>;
  filter: string;
  showArchived: boolean;
  onNavigate: (path: string) => void;
  onRemove: (path: string) => void;
  onTogglePin: (path: string) => void;
  onFilterChange: (value: string) => void;
  onShowArchived: () => void;
  newPath: string;
  onNewPathChange: (value: string) => void;
  onAdd: () => void;
}): React.JSX.Element {
  const hasMultipleEnvs = useMemo(() => {
    const envs = new Set(workspaces.map(w => w.environment ?? 'native'));
    return envs.size > 1;
  }, [workspaces]);

  const { pinned, unpinned, archived } = useMemo(() => {
    const now = Date.now();
    const q = filter.toLowerCase();

    const filtered = q
      ? workspaces.filter(w => w.path.toLowerCase().includes(q))
      : workspaces;

    const pin: WorkspaceInfo[] = [];
    const unpin: WorkspaceInfo[] = [];
    const arch: WorkspaceInfo[] = [];

    for (const ws of filtered) {
      if (pinnedPaths.has(ws.path)) {
        pin.push(ws);
      } else if (
        !ws.isExplicit &&
        ws.lastActivityAt &&
        now - ws.lastActivityAt > ARCHIVE_THRESHOLD_MS
      ) {
        arch.push(ws);
      } else {
        unpin.push(ws);
      }
    }

    return { pinned: pin, unpinned: unpin, archived: arch };
  }, [workspaces, pinnedPaths, filter]);

  if (workspaces.length === 0) {
    return (
      <>
        <p className="crispy-workspace-picker__empty">
          No workspaces found. Add a folder below to get started.
        </p>
        <AddFolderInput newPath={newPath} onNewPathChange={onNewPathChange} onAdd={onAdd} />
      </>
    );
  }

  return (
    <>
      {workspaces.length > 10 && (
        <input
          type="text"
          className="crispy-workspace-picker__filter"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder="Filter workspaces..."
          aria-label="Filter workspaces"
        />
      )}

      <div className="crispy-workspace-picker__list">
        {pinned.map(ws => (
          <WorkspaceRow
            key={ws.path}
            ws={ws}
            isPinned
            showEnv={hasMultipleEnvs}
            onNavigate={onNavigate}
            onRemove={onRemove}
            onTogglePin={onTogglePin}
          />
        ))}

        {pinned.length > 0 && unpinned.length > 0 && (
          <div className="crispy-workspace-picker__divider" />
        )}

        {unpinned.map(ws => (
          <WorkspaceRow
            key={ws.path}
            ws={ws}
            isPinned={false}
            showEnv={hasMultipleEnvs}
            onNavigate={onNavigate}
            onRemove={onRemove}
            onTogglePin={onTogglePin}
          />
        ))}

        {archived.length > 0 && !showArchived && (
          <button
            className="crispy-workspace-picker__show-archived"
            onClick={onShowArchived}
          >
            Show {archived.length} older workspace{archived.length > 1 ? 's' : ''}...
          </button>
        )}

        {showArchived && archived.map(ws => (
          <WorkspaceRow
            key={ws.path}
            ws={ws}
            isPinned={false}
            showEnv={hasMultipleEnvs}
            onNavigate={onNavigate}
            onRemove={onRemove}
            onTogglePin={onTogglePin}
          />
        ))}
      </div>

      <AddFolderInput newPath={newPath} onNewPathChange={onNewPathChange} onAdd={onAdd} />
    </>
  );
}

function WorkspaceRow({
  ws, isPinned, showEnv, onNavigate, onRemove, onTogglePin,
}: {
  ws: WorkspaceInfo;
  isPinned: boolean;
  showEnv: boolean;
  onNavigate: (path: string) => void;
  onRemove: (path: string) => void;
  onTogglePin: (path: string) => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className="crispy-workspace-picker__item"
      onClick={() => onNavigate(ws.path)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onNavigate(ws.path); }}
    >
      {isPinned && <span className="crispy-workspace-picker__pin-icon" title="Pinned">&#9733;</span>}
      <span className="crispy-workspace-picker__item-display">
        {formatCwd(ws.path)}
      </span>
      <div className="crispy-workspace-picker__item-meta">
        {showEnv && ws.environment && (
          <span className="crispy-workspace-picker__item-env">{ws.environment}</span>
        )}
        {ws.lastActivityAt && (
          <span className="crispy-workspace-picker__item-time">
            {formatWorkspaceTime(ws.lastActivityAt)}
          </span>
        )}
      </div>
      <div className="crispy-workspace-picker__item-actions" onClick={e => e.stopPropagation()}>
        <button
          className="crispy-workspace-picker__item-menu-btn"
          onClick={() => setMenuOpen(!menuOpen)}
          title="More options"
          aria-label="Workspace options"
        >
          &#8943;
        </button>
        {menuOpen && (
          <div className="crispy-workspace-picker__item-menu">
            <button onClick={() => { onNavigate(ws.path); setMenuOpen(false); }}>Open</button>
            <button onClick={() => { onTogglePin(ws.path); setMenuOpen(false); }}>
              {isPinned ? 'Unpin' : 'Pin'}
            </button>
            {ws.isExplicit && (
              <button onClick={() => { onRemove(ws.path); setMenuOpen(false); }}>Remove</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AddFolderInput({
  newPath, onNewPathChange, onAdd,
}: {
  newPath: string;
  onNewPathChange: (value: string) => void;
  onAdd: () => void;
}): React.JSX.Element {
  return (
    <div className="crispy-workspace-picker__add">
      <input
        type="text"
        className="crispy-workspace-picker__input"
        value={newPath}
        onChange={(e) => onNewPathChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }}
        placeholder="~/dev/my-project"
        aria-label="Workspace path"
      />
      <button
        className="crispy-workspace-picker__add-btn"
        onClick={onAdd}
        disabled={!newPath.trim()}
      >
        Add Folder
      </button>
    </div>
  );
}

export function WorkspacePicker(): React.JSX.Element {
  const transport = useTransport();
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [home, setHome] = useState('');
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [wslDistro, setWslDistro] = useState<string | null>(null);
  const [wslDismissed, setWslDismissed] = useState<Set<string>>(new Set());
  const [pinnedPaths, setPinnedPaths] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const logoRef = useRef<HTMLDivElement>(null);

  // 3D coin tilt — track mouse position across the entire viewport
  useEffect(() => {
    const MAX_TILT = 14;
    const onMove = (e: MouseEvent) => {
      const svg = logoRef.current?.querySelector('svg');
      if (!svg) return;
      const nx = (e.clientX / window.innerWidth - 0.5) * 2;
      const ny = (e.clientY / window.innerHeight - 0.5) * 2;
      svg.style.setProperty('--logo-ry', (nx * MAX_TILT) + 'deg');
      svg.style.setProperty('--logo-rx', (-ny * MAX_TILT) + 'deg');
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, []);

  // Listen for WSL detection events from Tauri
  useEffect(() => {
    const handler = (action: string) => {
      if (action.startsWith('wsl_detected:') && action.endsWith(':not_installed')) {
        const distro = action.split(':')[1];
        setWslDistro(distro);
      }
    };
    // Register on the global menu action handler used by Tauri
    const prev = (window as any).__CRISPY_MENU_ACTION__;
    (window as any).__CRISPY_MENU_ACTION__ = (action: string) => {
      handler(action);
      prev?.(action);
    };
    return () => { (window as any).__CRISPY_MENU_ACTION__ = prev; };
  }, []);

  // Load dismissed WSL distros from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('crispy-wsl-dismissed');
      if (stored) setWslDismissed(new Set(JSON.parse(stored)));
    } catch { /* ignore */ }
  }, []);

  // Load pinned workspaces from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('crispy-pinned-workspaces');
      if (stored) setPinnedPaths(new Set(JSON.parse(stored)));
    } catch { /* ignore */ }
  }, []);

  const togglePin = useCallback((path: string) => {
    setPinnedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      localStorage.setItem('crispy-pinned-workspaces', JSON.stringify([...next]));
      return next;
    });
  }, []);

  const dismissWsl = useCallback((distro: string) => {
    setWslDismissed(prev => {
      const next = new Set(prev);
      next.add(distro);
      localStorage.setItem('crispy-wsl-dismissed', JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Read flash message from URL query
  const flash = new URLSearchParams(window.location.search).get('flash') ?? '';

  const loadWorkspaces = useCallback(async () => {
    try {
      const result = await transport.listWorkspaces();
      setWorkspaces(result.workspaces);
      setHome(result.home);
      setError('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('WebSocket') || msg.includes('timed out')) {
        setError('Could not connect to the Crispy daemon. Is it running? Try: npx crispy-code start');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [transport]);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  const handleNavigate = (path: string) => {
    window.location.href = fsPathToUrlPath(path, home);
  };

  const handleAdd = async () => {
    const trimmed = newPath.trim();
    if (!trimmed) return;

    try {
      await transport.addWorkspaceRoot(trimmed);
      setNewPath('');
      setError('');
      await loadWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemove = async (path: string) => {
    try {
      await transport.removeWorkspaceRoot(path);
      await loadWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="crispy-workspace-picker">
      <div className="crispy-workspace-picker__card">
        <div className="crispy-workspace-picker__header">
          <div
            ref={logoRef}
            className="crispy-workspace-picker__logo"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: animatedLogoSvg }}
          />
          <h1 className="crispy-workspace-picker__title">Crispy</h1>
          <p className="crispy-workspace-picker__subtitle">Select a workspace to get started</p>
        </div>

        {flash && (
          <div className="crispy-workspace-picker__flash">{flash}</div>
        )}

        {error && (
          <div className="crispy-workspace-picker__error">{error}</div>
        )}

        {wslDistro && !wslDismissed.has(wslDistro) && (
          <WslInstallCard
            distro={wslDistro}
            onDismiss={() => dismissWsl(wslDistro)}
            onInstallComplete={() => {
              setWslDistro(null);
              loadWorkspaces();
            }}
          />
        )}

        {loading ? (
          <p className="crispy-workspace-picker__loading">Loading workspaces...</p>
        ) : (
          <WorkspaceList
            workspaces={workspaces}
            pinnedPaths={pinnedPaths}
            filter={filter}
            showArchived={showArchived}
            onNavigate={handleNavigate}
            onRemove={handleRemove}
            onTogglePin={togglePin}
            onFilterChange={setFilter}
            onShowArchived={() => setShowArchived(true)}
            newPath={newPath}
            onNewPathChange={setNewPath}
            onAdd={handleAdd}
          />
        )}
      </div>
    </div>
  );
}
