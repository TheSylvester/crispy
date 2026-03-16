/**
 * ProjectsView — Rosie-tracked projects grouped by stage
 *
 * Fetches projects via transport.getProjects() and renders them grouped
 * by stage (Active → Paused → Planning → Ready → Committed → Archived).
 * Supports drag-and-drop between stage groups and within-group reordering.
 *
 * @module ProjectsView
 */

import { useState, useEffect, useCallback, useRef, type ChangeEvent } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import type { WireProject } from '../../transport.js';
import type { AvailableCwd } from '../../hooks/useAvailableCwds.js';
import { ProjectCard } from './ProjectCard.js';

interface ProjectsViewProps {
  onSelectSession: (sessionId: string) => void;
  availableCwds: AvailableCwd[];
  selectedCwd: string | null;
  onCwdChange: (slug: string | null) => void;
}

const STAGE_ORDER = ['active', 'paused', 'planning', 'ready', 'committed', 'archived'] as const;
const STAGE_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  planning: 'Planning',
  ready: 'Ready',
  committed: 'Committed',
  archived: 'Archived',
};

const FILTER_STAGES = [
  { label: 'All', value: null },
  { label: 'Active', value: 'active' },
  { label: 'Paused', value: 'paused' },
  { label: 'Planning', value: 'planning' },
  { label: 'Ready', value: 'ready' },
] as const;

function sortProjects(projects: WireProject[]): WireProject[] {
  return [...projects].sort((a, b) => {
    // Projects with sort_order come first
    const aHasOrder = a.sortOrder != null;
    const bHasOrder = b.sortOrder != null;
    if (aHasOrder && bHasOrder) return a.sortOrder! - b.sortOrder!;
    if (aHasOrder && !bHasOrder) return -1;
    if (!aHasOrder && bHasOrder) return 1;
    // Fall back to recency
    return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
  });
}

export function ProjectsView({ onSelectSession, availableCwds, selectedCwd, onCwdChange }: ProjectsViewProps): React.JSX.Element {
  const transport = useTransport();
  const [projects, setProjects] = useState<WireProject[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(['archived']));
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const draggedIdRef = useRef<string | null>(null);

  const handleCwdChange = (e: ChangeEvent<HTMLSelectElement>) => {
    onCwdChange(e.target.value || null);
  };

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

  const toggleGroup = useCallback((stage: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage); else next.add(stage);
      return next;
    });
  }, []);

  const handleOpenFile = useCallback((path: string) => {
    transport.openFile(path);
  }, [transport]);

  // Drag-and-drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, projectId: string) => {
    draggedIdRef.current = projectId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', projectId);
    (e.currentTarget as HTMLElement).classList.add('crispy-project-dragging');
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    draggedIdRef.current = null;
    setDragOverStage(null);
    (e.currentTarget as HTMLElement).classList.remove('crispy-project-dragging');
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, stage: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverStage(stage);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverStage(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetStage: string) => {
    e.preventDefault();
    setDragOverStage(null);
    const projectId = draggedIdRef.current;
    if (!projectId) return;

    const project = projects.find(p => p.id === projectId);
    if (!project || project.stage === targetStage) return;

    // Optimistically update UI
    setProjects(prev => prev.map(p =>
      p.id === projectId ? { ...p, stage: targetStage as WireProject['stage'], sortOrder: undefined } : p
    ));

    // Persist to server
    transport.updateProjectStage(projectId, targetStage).catch(() => {
      // Revert on failure — refetch current state
      transport.getProjects().then(setProjects).catch(() => {});
    });
  }, [projects, transport]);

  // Filter by search query and stage filter
  let filtered = projects;
  if (stageFilter) {
    filtered = filtered.filter(p => p.stage === stageFilter);
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(p =>
      p.title.toLowerCase().includes(q)
      || (p.summary?.toLowerCase().includes(q) ?? false)
      || (p.status?.toLowerCase().includes(q) ?? false)
    );
  }

  // Search + CWD filter bar (rendered at top of all states except loading)
  const filterBar = (
    <div className="crispy-filter-bar">
      <div className="crispy-filter-bar__search-row">
        <input
          className="crispy-filter-bar__search"
          type="text"
          placeholder="Search projects…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>
      {availableCwds.length > 0 && (
        <select
          className="crispy-filter-bar__cwd"
          value={selectedCwd ?? ''}
          onChange={handleCwdChange}
          title="Filter by project"
        >
          <option value="">All Projects</option>
          {availableCwds.map(cwd => (
            <option key={cwd.slug} value={cwd.slug} title={cwd.fullPath}>
              {cwd.display}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  // Empty state
  if (loaded && projects.length === 0) {
    return (
      <div className="crispy-projects-container">
        {filterBar}
        <div className="crispy-session-empty crispy-session-empty--columnar">
          <span>No projects tracked yet</span>
          <span className="crispy-session-empty__hint">
            Enable Rosie bot in settings to start tracking your work across sessions.
          </span>
        </div>
      </div>
    );
  }

  // Search with no matches
  if (loaded && filtered.length === 0 && (searchQuery || stageFilter)) {
    return (
      <div className="crispy-projects-container">
        {filterBar}
        <div className="crispy-project-filter-bar">
          {FILTER_STAGES.map(f => (
            <button
              key={f.label}
              className={`crispy-project-filter-pill${stageFilter === f.value ? ' crispy-project-filter-pill--active' : ''}`}
              onClick={() => setStageFilter(f.value)}
            >
              {f.value && <span className={`crispy-project-filter-dot crispy-stage-dot--${f.value}`} />}
              {f.label}
            </button>
          ))}
        </div>
        <ul className="crispy-session-list">
          <li className="crispy-session-empty">No matches</li>
        </ul>
      </div>
    );
  }

  return (
    <div className="crispy-projects-container">
      {filterBar}
      {/* Filter pills */}
      <div className="crispy-project-filter-bar">
        {FILTER_STAGES.map(f => (
          <button
            key={f.label}
            className={`crispy-project-filter-pill${stageFilter === f.value ? ' crispy-project-filter-pill--active' : ''}`}
            onClick={() => setStageFilter(f.value)}
          >
            {f.value && <span className={`crispy-project-filter-dot crispy-stage-dot--${f.value}`} />}
            {f.label}
          </button>
        ))}
      </div>

      <ul className="crispy-session-list">
        {STAGE_ORDER.map(stage => {
          const items = sortProjects(filtered.filter(p => p.stage === stage));
          if (items.length === 0) return null;

          const collapsed = collapsedGroups.has(stage);
          const isDropTarget = dragOverStage === stage;

          return (
            <li
              key={stage}
              className={`crispy-session-group${stage === 'archived' ? ' crispy-session-group--archived' : ''}${isDropTarget ? ' crispy-project-drop-target' : ''}`}
              onDragOver={(e) => handleDragOver(e, stage)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, stage)}
            >
              <div
                className="crispy-session-group-header"
                onClick={() => toggleGroup(stage)}
              >
                <span className={`crispy-session-group-header__chevron${collapsed ? ' crispy-session-group-header__chevron--collapsed' : ''}`}>
                  &#9660;
                </span>
                <span className={`crispy-stage-dot crispy-stage-dot--${stage}`} />
                {STAGE_LABELS[stage]}
                <span className="crispy-session-group-header__count">{items.length}</span>
              </div>

              {!collapsed && (
                <ul className="crispy-session-group__list">
                  {items.map(project => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      isExpanded={expandedIds.has(project.id)}
                      onToggle={toggleProject}
                      onSelectSession={onSelectSession}
                      onOpenFile={handleOpenFile}
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
