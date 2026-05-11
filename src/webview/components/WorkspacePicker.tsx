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
import { useCrispyLogo } from '../hooks/useCrispyLogo.js';
import type { WorkspaceInfo } from '../../core/workspace-roots.js';

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

/** WSL lifecycle status from Tauri backend (matches Rust WslStatus enum). */
type WslBackendStatus =
  | { status: 'detecting' }
  | { status: 'not_found' }
  | { status: 'not_installed'; distro: string }
  | { status: 'starting'; distro: string }
  | { status: 'connected'; distro: string; port: number }
  | { status: 'failed'; distro: string; error: string };

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
  const logoSrc = useCrispyLogo();
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [home, setHome] = useState('');
  const [wslHome, setWslHome] = useState('');
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [wslStatus, setWslStatus] = useState<WslBackendStatus | null>(null);
  const [pinnedPaths, setPinnedPaths] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const logoRef = useRef<HTMLDivElement>(null);

  // 3D coin tilt — track mouse position across the entire viewport
  useEffect(() => {
    const MAX_TILT = 14;
    const onMove = (e: MouseEvent) => {
      const img = logoRef.current?.querySelector('img');
      if (!img) return;
      const nx = (e.clientX / window.innerWidth - 0.5) * 2;
      const ny = (e.clientY / window.innerHeight - 0.5) * 2;
      img.style.setProperty('--logo-ry', (nx * MAX_TILT) + 'deg');
      img.style.setProperty('--logo-rx', (-ny * MAX_TILT) + 'deg');
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, []);

  // Poll WSL lifecycle status from Tauri backend.
  // Fires immediately on mount, then polls every 500ms while non-terminal.
  // Stops on terminal states (not_found, not_installed, connected, failed).
  // Tolerates transient IPC errors by rescheduling from the catch branch.
  useEffect(() => {
    const ipc = (window as any).__TAURI_INTERNALS__;
    if (!ipc) return;

    const isTerminal = (s: WslBackendStatus) =>
      s.status === 'not_found' || s.status === 'not_installed' ||
      s.status === 'connected' || s.status === 'failed';

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sameStatus = (a: WslBackendStatus | null, b: WslBackendStatus) =>
      a !== null
      && a.status === b.status
      && (a as { distro?: string }).distro === (b as { distro?: string }).distro
      && (a as { port?: number }).port === (b as { port?: number }).port
      && (a as { error?: string }).error === (b as { error?: string }).error;

    const tick = async () => {
      if (cancelled) return;
      try {
        const status: WslBackendStatus = await ipc.invoke('get_wsl_status');
        if (cancelled) return;
        setWslStatus(prev => sameStatus(prev, status) ? prev : status);
        if (isTerminal(status)) return;
        timer = setTimeout(tick, 500);
      } catch {
        if (!cancelled) timer = setTimeout(tick, 500);
      }
    };

    tick();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
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

  const dismissWsl = useCallback(() => {
    setWslStatus(null);
  }, []);

  // Read flash message from URL query
  const flash = new URLSearchParams(window.location.search).get('flash') ?? '';

  const loadWorkspaces = useCallback(async () => {
    try {
      const result = await transport.listWorkspaces();
      const localPlatform = result.platform ?? 'unknown';
      const primaryWorkspaces: WorkspaceInfo[] = result.workspaces.map(ws => {
        if (ws.environment) return ws;
        if (localPlatform !== 'win32') return { ...ws, environment: localPlatform };
        return ws;
      });

      // Merge WSL workspaces if WSL daemon is connected
      let merged = primaryWorkspaces;
      if (wslStatus && wslStatus.status === 'connected') {
        try {
          const wslResp = await fetch(`http://localhost:${wslStatus.port}/api/workspaces`);
          if (wslResp.ok) {
            const wslData = await wslResp.json() as { home: string; platform?: string; workspaces: WorkspaceInfo[] };
            setWslHome(wslData.home);
            const wslWorkspaces = wslData.workspaces.map(ws => ({
              ...ws,
              environment: `WSL`,
            }));

            // Deduplicate by display name — when both daemons report the same
            // project (e.g. Windows daemon has ghost Unix paths from shared
            // ~/.claude/projects/), keep the one with the environment tag
            // that matches its actual platform. Prefer the tagged (WSL) entry.
            const allWorkspaces: WorkspaceInfo[] = [...primaryWorkspaces, ...wslWorkspaces];
            const byDisplay = new Map<string, WorkspaceInfo>();
            for (const ws of allWorkspaces) {
              const displayKey = formatCwd(ws.path);
              const existing = byDisplay.get(displayKey);
              if (!existing) {
                byDisplay.set(displayKey, ws);
              } else {
                // Prefer the entry with an environment tag (WSL-tagged over untagged ghost)
                // If both tagged or both untagged, keep the more recent one
                if (ws.environment && !existing.environment) {
                  byDisplay.set(displayKey, ws);
                } else if (!ws.environment && existing.environment) {
                  // keep existing
                } else if ((ws.lastActivityAt ?? 0) > (existing.lastActivityAt ?? 0)) {
                  byDisplay.set(displayKey, ws);
                }
              }
            }
            merged = Array.from(byDisplay.values());
            // Sort merged list by recency (most recent first)
            merged.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
          }
        } catch { /* WSL daemon unreachable — show primary only */ }
      }

      setWorkspaces(merged);
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
  }, [transport, wslStatus]);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  const handleNavigate = (path: string) => {
    // Find the workspace to check if it's a WSL workspace
    const ws = workspaces.find(w => w.path === path);
    if (ws?.environment === 'WSL' && wslStatus?.status === 'connected') {
      // WSL workspaces navigate to the WSL daemon port
      const urlPath = fsPathToUrlPath(path, wslHome);
      const wslUrl = `http://localhost:${wslStatus.port}${urlPath}`;
      window.location.href = wslUrl;
    } else {
      window.location.href = fsPathToUrlPath(path, home);
    }
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
          >
            <img src={logoSrc} alt="Crispy" draggable={false} />
          </div>
          <h1 className="crispy-workspace-picker__title">Crispy</h1>
          <p className="crispy-workspace-picker__subtitle">Select a workspace to get started</p>
        </div>

        {flash && (
          <div className="crispy-workspace-picker__flash">{flash}</div>
        )}

        {error && (
          <div className="crispy-workspace-picker__error">{error}</div>
        )}

        {wslStatus && wslStatus.status === 'detecting' && (
          <div className="crispy-wsl-install-card">
            <div className="crispy-wsl-install-card__title">
              Checking for WSL…
            </div>
          </div>
        )}

        {wslStatus && wslStatus.status === 'not_installed' && (
          <WslInstallCard
            distro={wslStatus.distro}
            onDismiss={dismissWsl}
            onInstallComplete={() => {
              setWslStatus(null);
              loadWorkspaces();
            }}
          />
        )}

        {wslStatus && wslStatus.status === 'starting' && (
          <div className="crispy-wsl-install-card">
            <div className="crispy-wsl-install-card__title">
              WSL ({wslStatus.distro})
            </div>
            <p className="crispy-wsl-install-card__desc">
              Starting WSL daemon...
            </p>
          </div>
        )}

        {wslStatus && wslStatus.status === 'connected' && (
          <div className="crispy-wsl-install-card">
            <button className="crispy-wsl-install-card__dismiss" onClick={dismissWsl} title="Dismiss">&times;</button>
            <div className="crispy-wsl-install-card__title">
              WSL ({wslStatus.distro})
            </div>
            <p className="crispy-wsl-install-card__desc crispy-wsl-install-card__desc--success">
              Connected on port {wslStatus.port}
            </p>
          </div>
        )}

        {wslStatus && wslStatus.status === 'failed' && (
          <div className="crispy-wsl-install-card">
            <button className="crispy-wsl-install-card__dismiss" onClick={dismissWsl} title="Dismiss">&times;</button>
            <div className="crispy-wsl-install-card__title">
              WSL ({wslStatus.distro})
            </div>
            <p className="crispy-wsl-install-card__desc crispy-wsl-install-card__desc--error">
              {wslStatus.error}
            </p>
            <p className="crispy-wsl-install-card__desc" style={{ fontSize: '0.85em', opacity: 0.7 }}>
              Check ~/.crispy/logs/wsl-daemon.log in WSL for details.
            </p>
          </div>
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
