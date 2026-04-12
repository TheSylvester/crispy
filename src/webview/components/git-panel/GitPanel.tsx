/**
 * GitPanel — git diff viewer for the unified sidebar
 *
 * Shows the current working tree's git diff in the right-side panel slot.
 * File list grouped by Staged / Modified / Untracked, with click-to-select
 * previewing one file's diff at a time via GitDiffView.
 *
 * @module git-panel/GitPanel
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import { useTabPanelOptional } from '../../context/TabPanelContext.js';
import { useCwd } from '../../hooks/useSessionCwd.js';
import { useGitInfo } from '../../hooks/useGitInfo.js';
import { GitDiffView } from './GitDiffView.js';
import { inferLanguage } from '../../renderers/tools/shared/tool-utils.js';
import type { GitDiffResult } from '../../../core/git-diff-service.js';
import type { ParsedDiff } from '../../../core/git-diff-parser.js';

const POLL_INTERVAL = 30_000;

/** Status badge letter and CSS modifier for each file status. */
const STATUS_BADGE: Record<string, { letter: string; modifier: string }> = {
  modified: { letter: 'M', modifier: 'modified' },
  added:    { letter: 'A', modifier: 'added' },
  deleted:  { letter: 'D', modifier: 'deleted' },
  renamed:  { letter: 'R', modifier: 'renamed' },
  untracked: { letter: '?', modifier: 'untracked' },
};

/** Refresh icon — circular arrow, 12x12 */
function RefreshIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8a7 7 0 0 1 13.3-3M15 8a7 7 0 0 1-13.3 3" />
      <polyline points="1 3 1 8 6 8" />
      <polyline points="15 13 15 8 10 8" />
    </svg>
  );
}

/** Collapsible chevron */
function GroupChevron({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      className={`crispy-git-panel__group-chevron${open ? ' crispy-git-panel__group-chevron--open' : ''}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3,2 7,5 3,8" />
    </svg>
  );
}

interface FileRowProps {
  displayPath: string;
  status: string;
  stats: { added: number; removed: number } | null;
  selected: boolean;
  onClick: () => void;
}

function FileRow({ displayPath, status, stats, selected, onClick }: FileRowProps): React.JSX.Element {
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.modified;
  return (
    <button
      className={`crispy-git-panel__file-row${selected ? ' crispy-git-panel__file-row--selected' : ''}`}
      onClick={onClick}
      title={displayPath}
    >
      <span className={`crispy-git-panel__status-badge crispy-git-panel__status-badge--${badge.modifier}`}>
        {badge.letter}
      </span>
      <span className="crispy-git-panel__file-path">{displayPath}</span>
      {stats && (stats.added > 0 || stats.removed > 0) && (
        <span className="crispy-diff-stats">
          {stats.added > 0 && <span className="crispy-diff-stats-added">+{stats.added}</span>}
          {stats.added > 0 && stats.removed > 0 && ' '}
          {stats.removed > 0 && <span className="crispy-diff-stats-removed">-{stats.removed}</span>}
        </span>
      )}
    </button>
  );
}

type SelectedFile = {
  key: string;
  diff: ParsedDiff | null;
  filePath: string;
};

interface GitPanelProps {
  mode?: 'sidebar' | 'tab';
}

export function GitPanel({ mode = 'sidebar' }: GitPanelProps): React.JSX.Element {
  const transport = useTransport();
  const { fullPath } = useCwd();
  const tabPanel = useTabPanelOptional();
  const setToolPanelWidthPx = tabPanel?.setToolPanelWidthPx ?? null;
  const gitInfo = useGitInfo();
  const [data, setData] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const fullPathRef = useRef(fullPath);
  fullPathRef.current = fullPath;

  const fetchDiff = useCallback((cancelled?: { current: boolean }) => {
    if (!fullPathRef.current) return;
    setLoading(true);
    transport.getGitDiff(fullPathRef.current).then(
      (result) => {
        if (cancelled?.current) return;
        setData(prev => JSON.stringify(prev) === JSON.stringify(result) ? prev : result);
        setLoading(false);
      },
      () => {
        if (cancelled?.current) return;
        setData(null);
        setLoading(false);
      },
    );
  }, [transport]);

  useEffect(() => {
    if (!fullPath) {
      setData(null);
      return;
    }
    const cancelled = { current: false };
    fetchDiff(cancelled);
    const id = setInterval(() => fetchDiff(cancelled), POLL_INTERVAL);
    return () => { cancelled.current = true; clearInterval(id); };
  }, [fullPath, fetchDiff]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (!setToolPanelWidthPx) return;
    e.preventDefault();
    const startX = e.clientX;
    const panel = (e.target as HTMLElement).closest('.crispy-git-panel');
    const startWidth = panel?.clientWidth ?? 350;
    const layout = panel?.closest('.crispy-tab-layout') ?? document.querySelector('.crispy-layout');
    layout?.setAttribute('data-resizing', '');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaPx = startX - moveEvent.clientX;
      setToolPanelWidthPx(Math.round(startWidth + deltaPx));
    };
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      layout?.removeAttribute('data-resizing');
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [setToolPanelWidthPx]);

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const selectFile = useCallback((key: string, diff: ParsedDiff | null, filePath: string) => {
    setSelected(prev => prev?.key === key ? null : { key, diff, filePath });
  }, []);

  const panelClass = mode === 'tab' ? 'crispy-git-panel crispy-git-panel--tab' : 'crispy-git-panel';

  // No CWD
  if (!fullPath) {
    return (
      <div className={panelClass}>
        {mode === 'sidebar' && <div className="crispy-tool-panel__resize-handle" onMouseDown={handleResizeStart} />}
        <div className="crispy-git-panel__header">
          <span className="crispy-git-panel__title">GIT</span>
        </div>
        <div className="crispy-git-panel__empty">Select a project to view changes</div>
      </div>
    );
  }

  const staged = data?.staged ?? [];
  const modified = data?.files ?? [];
  const untracked = data?.untracked ?? [];
  const totalFiles = staged.length + modified.length + untracked.length;
  const isClean = totalFiles === 0 && !loading;

  const renderGroup = (label: string, groupKey: string, files: ParsedDiff[], keyPrefix: string) => {
    if (files.length === 0) return null;
    const collapsed = collapsedGroups.has(groupKey);
    return (
      <div className="crispy-git-panel__group" key={groupKey}>
        <button className="crispy-git-panel__group-header" onClick={() => toggleGroup(groupKey)}>
          <GroupChevron open={!collapsed} />
          <span className="crispy-git-panel__group-label">{label}</span>
          <span className="crispy-git-panel__group-count">{files.length}</span>
        </button>
        {!collapsed && files.map((f, i) => {
          const key = `${keyPrefix}-${f.filePath}`;
          const displayPath = f.oldPath ? `${f.oldPath} \u2192 ${f.filePath}` : f.filePath;
          return (
            <FileRow
              key={key}
              displayPath={displayPath}
              status={f.status}
              stats={f.stats}
              selected={selected?.key === key}
              onClick={() => selectFile(key, f, f.filePath)}
            />
          );
        })}
      </div>
    );
  };

  const renderUntrackedGroup = () => {
    if (untracked.length === 0) return null;
    const collapsed = collapsedGroups.has('untracked');
    return (
      <div className="crispy-git-panel__group" key="untracked">
        <button className="crispy-git-panel__group-header" onClick={() => toggleGroup('untracked')}>
          <GroupChevron open={!collapsed} />
          <span className="crispy-git-panel__group-label">Untracked</span>
          <span className="crispy-git-panel__group-count">{untracked.length}</span>
        </button>
        {!collapsed && untracked.map((filePath) => {
          const key = `untracked-${filePath}`;
          return (
            <FileRow
              key={key}
              displayPath={filePath}
              status="untracked"
              stats={null}
              selected={selected?.key === key}
              onClick={() => selectFile(key, null, filePath)}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className={panelClass}>
      {mode === 'sidebar' && <div className="crispy-tool-panel__resize-handle" onMouseDown={handleResizeStart} />}
      <div className="crispy-git-panel__header">
        {gitInfo && (
          <div className="crispy-git-panel__branch-row">
            <span className="crispy-git-panel__branch" title={gitInfo.branch}>
              {gitInfo.branch}
            </span>
            <span className={`crispy-git-panel__dirty ${gitInfo.dirty ? 'crispy-git-panel__dirty--yes' : 'crispy-git-panel__dirty--clean'}`}>
              {gitInfo.dirty ? 'modified' : 'clean'}
            </span>
          </div>
        )}
        <div className="crispy-git-panel__summary-row">
          {!loading && <span className="crispy-git-panel__count">{totalFiles} changed file{totalFiles !== 1 ? 's' : ''}</span>}
          <button className="crispy-git-panel__refresh-btn" onClick={() => fetchDiff()} title="Refresh git diff">
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div className="crispy-git-panel__file-list">
        {loading && !data ? (
          <div className="crispy-git-panel__empty">Loading...</div>
        ) : isClean ? (
          <div className="crispy-git-panel__empty">Working tree clean</div>
        ) : (
          <>
            {renderGroup('Staged', 'staged', staged, 'staged')}
            {renderGroup('Modified', 'modified', modified, 'modified')}
            {renderUntrackedGroup()}
          </>
        )}
      </div>
      {selected && (
        <div className="crispy-git-panel__preview">
          <div className="crispy-git-panel__preview-header">
            <span className="crispy-git-panel__preview-path">{selected.filePath}</span>
          </div>
          <div className="crispy-git-panel__preview-scroll">
            {selected.diff && selected.diff.hunks.length > 0 ? (
              <GitDiffView
                hunks={selected.diff.hunks}
                language={inferLanguage(selected.filePath)}
              />
            ) : selected.diff?.binary ? (
              <div className="crispy-git-panel__empty">Binary file</div>
            ) : (
              <div className="crispy-git-panel__empty">
                {selected.diff ? 'No changes to display' : 'Untracked file — no diff available'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
