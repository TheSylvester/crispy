/**
 * ProjectHistory — Activity timeline for a project
 *
 * Toggleable, filterable (All/Status/Stage/Sessions/Files), sortable
 * (newest/oldest). Fetches from project_activity table.
 *
 * @module ProjectHistory
 */

import { useState, useCallback } from 'react';
import { useProjectActivity } from '../../hooks/useProjectActivity.js';
import { formatRelativeTime } from '../../utils/format.js';

interface ProjectHistoryProps {
  projectId: string;
}

const FILTER_KINDS = [
  { label: 'All', value: undefined },
  { label: 'Status', value: 'status_update' },
  { label: 'Stage', value: 'stage_change' },
  { label: 'Sessions', value: 'session_linked' },
  { label: 'Files', value: 'file_linked' },
] as const;

function formatEntryText(kind: string, entry: {
  oldStage?: string; newStage?: string;
  oldStatus?: string; newStatus?: string;
  narrative?: string;
}): React.JSX.Element {
  switch (kind) {
    case 'created':
      return <span>Project created {entry.newStage && <>in <span className="hl">{entry.newStage}</span></>}</span>;
    case 'stage_change':
      return <span><span className="hl">{entry.oldStage}</span><span className="arrow">&rarr;</span><span className="hl">{entry.newStage}</span></span>;
    case 'status_update':
      return <span>Status: <span className="hl">{entry.newStatus}</span></span>;
    case 'session_linked':
      return <span>Session linked</span>;
    case 'file_linked':
      return <span>File: <span className="hl">{entry.narrative}</span></span>;
    case 'entity_added':
      return <span>Entity: <span className="hl">{entry.narrative}</span></span>;
    default:
      return <span>{kind}</span>;
  }
}

export function ProjectHistory({ projectId }: ProjectHistoryProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [filterKind, setFilterKind] = useState<string | undefined>(undefined);
  const [sortNewest, setSortNewest] = useState(true);

  const { entries, loading } = useProjectActivity(
    open ? projectId : null,
    filterKind ? { kind: filterKind } : undefined,
  );

  const sorted = sortNewest ? entries : [...entries].reverse();

  const toggleOpen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(prev => !prev);
  }, []);

  return (
    <div className="crispy-project-history">
      <div
        className={`crispy-project-history-toggle${open ? ' crispy-project-history-toggle--open' : ''}`}
        onClick={toggleOpen}
      >
        <span className="crispy-project-history-toggle__chevron">&#9654;</span>
        History
      </div>

      {open && (
        <>
          <div className="crispy-project-history-controls">
            {FILTER_KINDS.map(f => (
              <button
                key={f.label}
                className={`crispy-project-history-filter${filterKind === f.value ? ' crispy-project-history-filter--active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setFilterKind(f.value); }}
              >
                {f.label}
              </button>
            ))}
            <button
              className="crispy-project-history-sort"
              onClick={(e) => { e.stopPropagation(); setSortNewest(prev => !prev); }}
            >
              {sortNewest ? 'Newest' : 'Oldest'}
            </button>
          </div>

          <div className={`crispy-project-timeline${open ? ' crispy-project-timeline--open' : ''}`}>
            {loading && <div className="crispy-project-timeline-loading">Loading...</div>}
            {!loading && sorted.length === 0 && (
              <div className="crispy-project-timeline-empty">No activity</div>
            )}
            {sorted.map(entry => (
              <div key={entry.id} className="crispy-project-timeline-entry">
                <span className={`crispy-project-timeline-dot crispy-project-timeline-dot--${entry.actor}`} />
                <span className={`crispy-project-timeline-source crispy-project-timeline-source--${entry.actor}`}>
                  {entry.actor}
                </span>
                <span className="crispy-project-timeline-text">
                  {formatEntryText(entry.kind, entry)}
                </span>
                <span className="crispy-project-timeline-time">
                  {formatRelativeTime(new Date(entry.ts).toISOString())}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
