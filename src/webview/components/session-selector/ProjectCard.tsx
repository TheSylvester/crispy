/**
 * ProjectCard — Collapsed/expanded card for a single project
 *
 * Collapsed: icon + title + relativeTime + status line + meta (branch, sessions, files, entities, blocker)
 * Expanded: description, blocker, sessions, files, origin, history timeline
 *
 * @module ProjectCard
 */

import { useCallback } from 'react';
import type { WireProject } from '../../transport.js';
import { formatRelativeTime } from '../../utils/format.js';
import { ProjectHistory } from './ProjectHistory.js';

interface ProjectCardProps {
  project: WireProject;
  isExpanded: boolean;
  onToggle: (id: string) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenFile: (path: string) => void;
  onDragStart?: (e: React.DragEvent, projectId: string) => void;
  onDragEnd?: (e: React.DragEvent) => void;
}

function getTimeClass(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  if (diffMs < 3600_000) return 'crispy-project-time--fresh';      // < 1h
  if (diffMs < 86400_000) return 'crispy-project-time--warm';      // < 1d
  if (diffMs < 604800_000) return 'crispy-project-time--stale';    // < 1w
  return 'crispy-project-time--cold';
}

export function ProjectCard({
  project: p,
  isExpanded,
  onToggle,
  onSelectSession,
  onOpenFile,
  onDragStart,
  onDragEnd,
}: ProjectCardProps): React.JSX.Element {
  const handleSessionClick = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    onSelectSession(sessionId);
  }, [onSelectSession]);

  const handleFileClick = useCallback((e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    onOpenFile(path);
  }, [onOpenFile]);

  const isArchived = p.stage === 'archived';

  return (
    <li
      className={`crispy-project-row${isExpanded ? ' crispy-project-row--expanded' : ''}${isArchived ? ' crispy-project-row--archived' : ''}`}
      onClick={() => onToggle(p.id)}
      draggable
      onDragStart={(e) => onDragStart?.(e, p.id)}
      onDragEnd={onDragEnd}
    >
      {/* Icon column */}
      <span className="crispy-project-icon">{p.icon || '\u{1F4C1}'}</span>

      {/* Content column */}
      <div className="crispy-project-content">
        <div className="crispy-project-title">{p.title}</div>

        {p.status && (
          <div className="crispy-project-status-text">{p.status}</div>
        )}

        <div className="crispy-project-meta">
          {p.branch && (
            <span className="crispy-project-branch">{p.branch}</span>
          )}
          <span className="crispy-project-meta-item">
            {p.sessionCount} session{p.sessionCount !== 1 ? 's' : ''}
          </span>
          {p.files.length > 0 && (
            <span className="crispy-project-meta-item">
              {p.files.length} file{p.files.length !== 1 ? 's' : ''}
            </span>
          )}
          {p.entities && p.entities.slice(0, 3).map(e => (
            <span key={e} className="crispy-project-entity-tag">{e.split('/').pop()}</span>
          ))}
          {p.blockedBy && (
            <span className="crispy-project-blocker-tag">Blocked</span>
          )}
        </div>

        {/* Expanded detail */}
        {isExpanded && (
          <div className="crispy-project-detail" onClick={e => e.stopPropagation()}>
            {p.summary && (
              <>
                <div className="crispy-project-detail-label">Description</div>
                <div className="crispy-project-detail-description">{p.summary}</div>
              </>
            )}

            {p.blockedBy && (
              <div className="crispy-project-detail-blocker">
                Blocked on: {p.blockedBy}
              </div>
            )}

            {p.sessions.length > 0 && (
              <>
                <div className="crispy-project-detail-label">Sessions</div>
                <ul className="crispy-project-detail-sessions">
                  {p.sessions.map(s => (
                    <li
                      key={s.sessionFile}
                      onClick={e => handleSessionClick(e, s.sessionId)}
                    >
                      <span className="crispy-project-detail-session-time">
                        {formatRelativeTime(s.modifiedAt)}
                      </span>
                      <div className="crispy-project-detail-session-content">
                        <span className="crispy-project-detail-session-title">{s.title}</span>
                        {s.preview && (
                          <span className="crispy-project-detail-session-preview">{s.preview}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {p.files.length > 0 && (
              <>
                <div className="crispy-project-detail-label">Files</div>
                <ul className="crispy-project-detail-files">
                  {p.files.map(f => (
                    <li key={f.path} onClick={e => handleFileClick(e, f.path)}>
                      <span>{f.path}</span>
                      {f.note && <span className="crispy-project-detail-file-note">{f.note}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {p.originSessionTitle && (
              <div className="crispy-project-detail-origin">
                Created from: <span className="crispy-project-detail-origin-link">{p.originSessionTitle}</span>
              </div>
            )}

            {isArchived && p.createdAt && p.closedAt && (
              <div className="crispy-project-detail-duration">
                Took {Math.ceil((new Date(p.closedAt).getTime() - new Date(p.createdAt).getTime()) / 86400_000)}d
              </div>
            )}

            <ProjectHistory projectId={p.id} />
          </div>
        )}
      </div>

      {/* Time column */}
      <span className={`crispy-project-time ${getTimeClass(p.lastActivityAt)}`}>
        {formatRelativeTime(p.lastActivityAt)}
      </span>
    </li>
  );
}
