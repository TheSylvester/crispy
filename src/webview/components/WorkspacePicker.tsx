/**
 * WorkspacePicker — root page workspace selector
 *
 * Shown at `/` when no workspace CWD is set (websocket mode, no meta tag).
 * Lists known workspaces and provides an "Add folder" input.
 *
 * @module WorkspacePicker
 */

import { useState, useEffect, useCallback } from 'react';
import { useTransport } from '../context/TransportContext.js';
import { fsPathToUrlPath } from '../../core/url-path-resolver.js';
import { formatCwd } from '../hooks/useSessionCwd.js';
import type { WorkspaceInfo } from '../../core/workspace-roots.js';
// esbuild --loader:.svg=text imports the raw SVG markup as a string
// @ts-expect-error — no type declarations for raw SVG import
import crispyLogoSvg from '../../../media/crispy-icon.svg';

export function WorkspacePicker(): React.JSX.Element {
  const transport = useTransport();
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [home, setHome] = useState('');
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Read flash message from URL query
  const flash = new URLSearchParams(window.location.search).get('flash') ?? '';

  const loadWorkspaces = useCallback(async () => {
    try {
      const result = await transport.listWorkspaces();
      setWorkspaces(result.workspaces);
      setHome(result.home);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
            className="crispy-workspace-picker__logo"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: crispyLogoSvg }}
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

        {loading ? (
          <p className="crispy-workspace-picker__loading">Loading workspaces...</p>
        ) : (
          <>
            <div className="crispy-workspace-picker__list">
              {workspaces.length === 0 ? (
                <p className="crispy-workspace-picker__empty">
                  No workspaces found. Add a folder below to get started.
                </p>
              ) : (
                workspaces.map((ws) => (
                  <div
                    key={ws.path}
                    className="crispy-workspace-picker__item"
                    onClick={() => handleNavigate(ws.path)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleNavigate(ws.path); }}
                  >
                    <span className="crispy-workspace-picker__item-display">
                      {formatCwd(ws.path)}
                    </span>
                    <span className="crispy-workspace-picker__item-path">
                      {ws.path}
                    </span>
                    {ws.isExplicit && (
                      <button
                        className="crispy-workspace-picker__item-remove"
                        onClick={(e) => { e.stopPropagation(); handleRemove(ws.path); }}
                        title="Remove workspace root"
                        aria-label={`Remove ${ws.path}`}
                      >
                        &times;
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="crispy-workspace-picker__add">
              <input
                type="text"
                className="crispy-workspace-picker__input"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
                placeholder="~/dev/my-project"
                aria-label="Workspace path"
              />
              <button
                className="crispy-workspace-picker__add-btn"
                onClick={handleAdd}
                disabled={!newPath.trim()}
              >
                Add Folder
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
