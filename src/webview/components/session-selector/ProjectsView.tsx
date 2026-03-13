/**
 * ProjectsView — Rosie-tracked projects grouped by status
 *
 * Fetches projects via transport.getProjects() and renders them grouped
 * by status (Active → Blocked → Planned → Done). Reuses session-item
 * CSS classes for card layout. Click expands inline to show resource
 * files and linked sessions.
 *
 * @module ProjectsView
 */

import { useState, useEffect, useCallback } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import type { WireProject } from '../../transport.js';
import { formatRelativeTime } from '../../utils/format.js';

interface ProjectsViewProps {
  searchQuery: string;
  onSelectSession: (sessionId: string) => void;
}

const STATUS_ORDER = ['active', 'blocked', 'planned', 'done'] as const;
const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  blocked: 'Blocked',
  planned: 'Planned',
  done: 'Done',
};

export function ProjectsView({ searchQuery, onSelectSession }: ProjectsViewProps): React.JSX.Element {
  const transport = useTransport();
  const [projects, setProjects] = useState<WireProject[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(['done']));

  useEffect(() => {
    let cancelled = false;
    transport.getProjects()
      .then(data => { if (!cancelled) { setProjects(data); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [transport]);

  const toggleProject = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((status: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status); else next.add(status);
      return next;
    });
  }, []);

  const handleSessionClick = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    onSelectSession(sessionId);
  }, [onSelectSession]);

  const handleResourceClick = useCallback((e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    transport.openFile(path);
  }, [transport]);

  // Filter by search query
  const filtered = searchQuery
    ? projects.filter(p => {
        const q = searchQuery.toLowerCase();
        return p.title.toLowerCase().includes(q)
          || (p.summary?.toLowerCase().includes(q) ?? false);
      })
    : projects;

  // Empty state
  if (loaded && projects.length === 0) {
    return (
      <div className="crispy-session-empty crispy-session-empty--columnar">
        <span>No projects tracked yet</span>
        <span className="crispy-session-empty__hint">
          Enable Rosie bot in settings to start tracking your work across sessions.
        </span>
      </div>
    );
  }

  // Search with no matches
  if (loaded && filtered.length === 0 && searchQuery) {
    return (
      <ul className="crispy-session-list">
        <li className="crispy-session-empty">No matches</li>
      </ul>
    );
  }

  return (
    <ul className="crispy-session-list">
      {STATUS_ORDER.map(status => {
        const items = filtered.filter(p => p.status === status);
        if (items.length === 0) return null;

        const collapsed = collapsedGroups.has(status);

        return (
          <li
            key={status}
            className={`crispy-session-group${status === 'done' ? ' crispy-session-group--done' : ''}`}
          >
            <div
              className="crispy-session-group-header"
              onClick={() => toggleGroup(status)}
            >
              <span className={`crispy-session-group-header__chevron${collapsed ? ' crispy-session-group-header__chevron--collapsed' : ''}`}>
                &#9660;
              </span>
              <span className={`crispy-status-dot crispy-status-dot--${status}`} />
              {STATUS_LABELS[status]}
              <span className="crispy-session-group-header__count">{items.length}</span>
            </div>

            {!collapsed && (
              <ul className="crispy-session-group__list">
                {items.map(project => {
                  const isExpanded = expandedIds.has(project.id);
                  return (
                    <li
                      key={project.id}
                      className={`crispy-session-item${isExpanded ? ' crispy-session-item--expanded' : ''}`}
                      onClick={() => toggleProject(project.id)}
                    >
                      <div className="crispy-session-item__header">
                        <span className="crispy-session-item__label">{project.title}</span>
                        <div className="crispy-session-item__meta">
                          <span className="crispy-session-item__time">
                            {formatRelativeTime(project.lastActivityAt)}
                          </span>
                        </div>
                      </div>

                      {project.summary && (
                        <div className="crispy-session-item__preview">{project.summary}</div>
                      )}

                      {project.blockedBy && (
                        <div className="crispy-project-blocked">Blocked on: {project.blockedBy}</div>
                      )}

                      <div className="crispy-project-meta">
                        {project.branch && (
                          <span className="crispy-project-branch">{project.branch}</span>
                        )}
                        <span>{project.sessionCount} session{project.sessionCount !== 1 ? 's' : ''}</span>
                      </div>

                      {isExpanded && (
                        <>
                          {project.files.length > 0 && (
                            <ul className="crispy-project-resources">
                              {project.files.map(f => {
                                const filename = f.path.split('/').pop() ?? f.path;
                                return (
                                  <li
                                    key={f.path}
                                    className="crispy-project-resource"
                                    title={f.note ?? f.path}
                                    onClick={e => handleResourceClick(e, f.path)}
                                  >
                                    <span className="crispy-project-resource__icon">&#128196;</span>
                                    {filename}
                                  </li>
                                );
                              })}
                            </ul>
                          )}

                          {project.sessions.length > 0 && (
                            <ul className="crispy-project-sessions">
                              {project.sessions.map(s => (
                                <li
                                  key={s.sessionFile}
                                  className="crispy-project-session-item"
                                  onClick={e => handleSessionClick(e, s.sessionId)}
                                >
                                  <span className="crispy-project-session-item__title">{s.title}</span>
                                  <span className="crispy-project-session-item__time">
                                    {formatRelativeTime(s.modifiedAt)}
                                  </span>
                                  {s.preview && (
                                    <span className="crispy-project-session-item__preview">{s.preview}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
