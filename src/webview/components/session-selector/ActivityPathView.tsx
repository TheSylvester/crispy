/**
 * ActivityPathView — Chronological user activity across all sessions
 *
 * Displays a matrix: user prompts as rows (left columns, sticky),
 * session lanes as columns (horizontally scrollable). Each cell
 * at a prompt/session intersection shows a truncated assistant
 * response preview; hover reveals the full text via native title tooltip.
 *
 * Left side has two sticky columns: TIME (date+time) and YOUR PROMPT
 * (3-line clamped user message). Session lane cells show 3-line
 * clamped response text. Pagination via "Load more".
 *
 * @module ActivityPathView
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import { useSession } from '../../context/SessionContext.js';
import { usePreferences } from '../../context/PreferencesContext.js';
import type { ActivityIndexEntry } from '../../../core/activity-index.js';
import type { WireSessionInfo } from '../../transport.js';

// ============================================================================
// Constants
// ============================================================================

const PAGE_SIZE = 25;

/** Muted palette for per-lane color identity (dark-mode friendly, 8 stops cycling) */
const LANE_COLORS = [
  '#4a9eff', // blue
  '#4ec989', // green
  '#b07ee8', // purple
  '#e87ea3', // pink
  '#4ecdc4', // teal
  '#e8c84e', // amber
  '#e87e6a', // coral
  '#6ac4e8', // sky
];

// ============================================================================
// Types
// ============================================================================

interface SessionLane {
  file: string;
  session?: WireSessionInfo;
  label: string;
  lastActivity: string;
}

// ============================================================================
// Helpers
// ============================================================================

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ============================================================================
// TruncatedCell — stateless wrapper with native title tooltip (zero JS cost)
// ============================================================================

function TruncatedCell({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`crispy-activity-path__truncated ${className ?? ''}`} title={text}>
      <span className="crispy-activity-path__clamp">{text}</span>
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

export function ActivityPathView(): React.JSX.Element {
  const transport = useTransport();
  const { sessions, setSelectedSessionId } = useSession();
  const { setSidebarCollapsed } = usePreferences();

  const [entries, setEntries] = useState<ActivityIndexEntry[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [responsePreviews, setResponsePreviews] = useState<Map<string, string | null>>(new Map());

  // ---- Fetch activity log (all entries, no time range filter) ----
  useEffect(() => {
    setLoading(true);
    transport.getActivityLog({}).then(result => {
      setEntries(result);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [transport]);

  // ---- Build session lanes (columns) ----
  const sessionMap = useMemo(() => {
    const map = new Map<string, WireSessionInfo>();
    for (const s of sessions) {
      if (s.path) map.set(s.path, s);
    }
    return map;
  }, [sessions]);

  const lanes: SessionLane[] = useMemo(() => {
    // Group entries by file, find most recent activity per file
    const fileActivity = new Map<string, string>();
    for (const e of entries) {
      const existing = fileActivity.get(e.file);
      if (!existing || e.timestamp > existing) {
        fileActivity.set(e.file, e.timestamp);
      }
    }

    // Build lanes, sorted by most recent activity first
    return [...fileActivity.entries()]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([file, lastActivity]) => {
        const session = sessionMap.get(file);
        const label = session?.label
          || session?.lastMessage
          || file.split('/').pop()?.replace('.jsonl', '')
          || file;
        return { file, session, label, lastActivity };
      });
  }, [entries, sessionMap]);

  // Keyed lookup for O(1) lane-by-file access (used in time/prompt columns)
  const laneByFile = useMemo(() => {
    const map = new Map<string, SessionLane>();
    for (const lane of lanes) map.set(lane.file, lane);
    return map;
  }, [lanes]);

  // Per-lane color assignment (cycles through palette by lane order)
  const laneColorMap = useMemo(() => {
    const map = new Map<string, string>();
    lanes.forEach((lane, i) => map.set(lane.file, LANE_COLORS[i % LANE_COLORS.length]));
    return map;
  }, [lanes]);

  // ---- Sort + paginate entries ----
  // sortedEntries: newest-first (used for slicing the N most recent)
  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [entries]);

  // paginatedEntries: take the N most recent, then reverse to chronological
  // (oldest at top, newest at bottom — like a chat log)
  const paginatedEntries = useMemo(() => {
    return sortedEntries.slice(0, (page + 1) * PAGE_SIZE).reverse();
  }, [sortedEntries, page]);

  const hasMore = paginatedEntries.length < sortedEntries.length;

  // Ref mirror of responsePreviews for stable reads inside the effect below
  // (avoids infinite loop from including responsePreviews in deps, while giving
  // a fresh read to prevent double-fetching on rapid pagination)
  const previewCacheRef = useRef(responsePreviews);
  previewCacheRef.current = responsePreviews;

  // ---- Batch-load response previews for visible entries (merge, don't replace) ----
  useEffect(() => {
    if (paginatedEntries.length === 0) return;

    const uncached = paginatedEntries.filter(
      entry => !previewCacheRef.current.has(`${entry.file}:${entry.offset}`)
    );
    if (uncached.length === 0) return;

    Promise.all(
      uncached.map(entry => {
        const key = `${entry.file}:${entry.offset}`;
        return transport.getResponsePreview(entry.file, entry.offset)
          .then(preview => ({ key, preview }))
          .catch(() => ({ key, preview: null }));
      })
    ).then(results => {
      setResponsePreviews(prev => {
        const next = new Map(prev);
        for (const { key, preview } of results) {
          next.set(key, preview);
        }
        return next;
      });
    });
  }, [paginatedEntries, transport]);

  // ---- Click-to-navigate handler ----
  const handleCellClick = useCallback((lane: SessionLane) => {
    if (lane.session) {
      setSelectedSessionId(lane.session.sessionId);
      setTimeout(() => setSidebarCollapsed(true), 200);
    }
  }, [setSelectedSessionId, setSidebarCollapsed]);

  // ---- Scroll management ----
  const matrixRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on initial load (newest entries are at the bottom)
  const didScrollRef = useRef(false);
  useEffect(() => {
    if (!loading && paginatedEntries.length > 0 && !didScrollRef.current) {
      didScrollRef.current = true;
      requestAnimationFrame(() => {
        matrixRef.current?.scrollTo({ top: matrixRef.current.scrollHeight });
      });
    }
  }, [loading, paginatedEntries]);

  // ---- Preserve scroll position when "Load more" prepends older entries ----
  // Capture scrollHeight before React commits new DOM nodes, then adjust
  // scrollTop by the delta so the user's viewport doesn't jump.
  const prevScrollHeightRef = useRef<number>(0);
  const prevPageRef = useRef(page);

  // Snapshot before render
  if (page !== prevPageRef.current && matrixRef.current) {
    prevScrollHeightRef.current = matrixRef.current.scrollHeight;
    prevPageRef.current = page;
  }

  useEffect(() => {
    const el = matrixRef.current;
    if (!el || !didScrollRef.current || prevScrollHeightRef.current === 0) return;
    const delta = el.scrollHeight - prevScrollHeightRef.current;
    if (delta > 0) {
      el.scrollTop += delta;
    }
    prevScrollHeightRef.current = 0;
  }, [paginatedEntries]);

  // ---- Hover crosshair (zero React re-renders — direct DOM class toggles) ----
  const hoverRef = useRef<{ row: string; file: string; els: Element[] } | null>(null);
  const laneScrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearHighlights = useCallback(() => {
    clearTimeout(laneScrollTimer.current);
    if (!hoverRef.current) return;
    for (const el of hoverRef.current.els) {
      el.classList.remove(
        'crispy-activity-path__row--highlighted',
        'crispy-activity-path__row--sibling',
        'crispy-activity-path__cell--row-hover',
        'crispy-activity-path__lane--focused',
      );
    }
    hoverRef.current = null;
  }, []);

  const handleMatrixPointer = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-row]') as HTMLElement | null;
    const matrix = matrixRef.current;
    if (!target || !matrix) { clearHighlights(); return; }

    const { row, file } = target.dataset;
    if (!row || !file) { clearHighlights(); return; }

    // Skip if same cell
    const prev = hoverRef.current;
    if (prev?.row === row && prev?.file === file) return;

    clearHighlights();
    const els: Element[] = [];

    // Row highlight: all elements with matching data-row
    for (const el of Array.from(matrix.querySelectorAll(`[data-row="${CSS.escape(row)}"]`))) {
      const cls = el.classList.contains('crispy-activity-path__cell')
        ? 'crispy-activity-path__cell--row-hover'
        : 'crispy-activity-path__row--highlighted';
      el.classList.add(cls);
      els.push(el);
    }

    // Column highlight: lane div with matching data-lane-file
    const lane = matrix.querySelector(`[data-lane-file="${CSS.escape(file)}"]`);
    if (lane) {
      lane.classList.add('crispy-activity-path__lane--focused');
      els.push(lane);

      // Debounced horizontal-only scroll — waits for mouse to settle so vertical
      // scrolling isn't interrupted, and never touches scrollTop.
      clearTimeout(laneScrollTimer.current);
      laneScrollTimer.current = setTimeout(() => {
        const laneEl = lane as HTMLElement;
        const lanesBox = laneEl.offsetParent as HTMLElement | null;
        if (!lanesBox) return;
        const absLeft = lanesBox.offsetLeft + laneEl.offsetLeft;
        const absRight = absLeft + laneEl.offsetWidth;

        // Visible horizontal band = scrollLeft + sticky columns → scrollLeft + clientWidth
        const timeCol = matrix.querySelector('.crispy-activity-path__time-col') as HTMLElement | null;
        const promptCol = matrix.querySelector('.crispy-activity-path__prompt-col') as HTMLElement | null;
        const stickyW = (timeCol?.offsetWidth ?? 80) + (promptCol?.offsetWidth ?? 200);

        const viewLeft = matrix.scrollLeft + stickyW;
        const viewRight = matrix.scrollLeft + matrix.clientWidth;

        if (absLeft < viewLeft) {
          matrix.scrollTo({ left: absLeft - stickyW, behavior: 'smooth' });
        } else if (absRight > viewRight) {
          matrix.scrollTo({ left: absRight - matrix.clientWidth + 8, behavior: 'smooth' });
        }
      }, 150);
    }

    // Sibling highlight: other rows from the same session (same file, different row)
    const siblingSelector = `[data-file="${CSS.escape(file)}"]:not([data-row="${CSS.escape(row)}"])`;
    for (const el of Array.from(matrix.querySelectorAll(siblingSelector))) {
      // Only highlight time/prompt rows, not lane cells
      if (!el.classList.contains('crispy-activity-path__cell')) {
        el.classList.add('crispy-activity-path__row--sibling');
        els.push(el);
      }
    }

    hoverRef.current = { row, file, els };
  }, [clearHighlights]);

  // ---- Render ----
  if (loading) {
    return <div className="crispy-activity-path__empty">Loading activity...</div>;
  }

  if (entries.length === 0) {
    return (
      <div className="crispy-activity-path">
        <div className="crispy-activity-path__empty">No activity found</div>
      </div>
    );
  }

  return (
    <div className="crispy-activity-path">
      <div className="crispy-activity-path__controls">
        <span className="crispy-activity-path__count">
          Showing {paginatedEntries.length} of {sortedEntries.length}
        </span>
      </div>

      <div
        className="crispy-activity-path__matrix"
        ref={matrixRef}
        onMouseOver={handleMatrixPointer}
        onMouseLeave={clearHighlights}
      >
        {/* TIME column (sticky left:0) */}
        <div className="crispy-activity-path__time-col">
          <div className="crispy-activity-path__header crispy-activity-path__header--time">
            Time
          </div>
          {hasMore && (
            <div className="crispy-activity-path__time-row crispy-activity-path__load-more-spacer" />
          )}
          {paginatedEntries.map((entry, i) => {
            const entryLane = laneByFile.get(entry.file);
            const isClickable = !!entryLane?.session;
            return (
              <div
                key={`time-${entry.timestamp}-${entry.uuid ?? i}`}
                className="crispy-activity-path__time-row"
                data-row={i}
                data-file={entry.file}
                onClick={isClickable ? () => handleCellClick(entryLane) : undefined}
                style={{ cursor: isClickable ? 'pointer' : undefined, '--lane-color': laneColorMap.get(entry.file) } as React.CSSProperties}
              >
                <span className="crispy-activity-path__date">{formatDate(entry.timestamp)}</span>
                <span className="crispy-activity-path__clock">{formatTime(entry.timestamp)}</span>
              </div>
            );
          })}
        </div>

        {/* PROMPT column (sticky left:80px) */}
        <div className="crispy-activity-path__prompt-col">
          <div className="crispy-activity-path__header crispy-activity-path__header--prompts">
            Your Prompt
          </div>
          {hasMore && (
            <div className="crispy-activity-path__prompt-row crispy-activity-path__load-more-row">
              <button
                className="crispy-activity-path__load-more"
                onClick={() => setPage(p => p + 1)}
              >
                Load more
              </button>
            </div>
          )}
          {paginatedEntries.map((entry, i) => {
            const entryLane = laneByFile.get(entry.file);
            const isClickable = !!entryLane?.session;
            return (
              <div
                key={`prompt-${entry.timestamp}-${entry.uuid ?? i}`}
                className="crispy-activity-path__prompt-row"
                data-row={i}
                data-file={entry.file}
                onClick={isClickable ? () => handleCellClick(entryLane) : undefined}
                style={{ cursor: isClickable ? 'pointer' : undefined, '--lane-color': laneColorMap.get(entry.file) } as React.CSSProperties}
              >
                <TruncatedCell text={entry.preview} className="crispy-activity-path__prompt-text" />
              </div>
            );
          })}
        </div>

        {/* Session lanes (scrollable columns) */}
        <div className="crispy-activity-path__lanes">
          {lanes.map(lane => (
            <div
              key={lane.file}
              className="crispy-activity-path__lane"
              data-lane-file={lane.file}
              style={{ '--lane-color': laneColorMap.get(lane.file) } as React.CSSProperties}
            >
              <div
                className="crispy-activity-path__header crispy-activity-path__header--lane"
                title={lane.session?.label || lane.file}
              >
                <span className="crispy-activity-path__clamp crispy-activity-path__lane-label">
                  {lane.label}
                </span>
              </div>
              {hasMore && (
                <div className="crispy-activity-path__cell crispy-activity-path__load-more-spacer" />
              )}
              {paginatedEntries.map((entry, i) => {
                const isMatch = entry.file === lane.file;
                const cellKey = `${entry.timestamp}-${entry.uuid ?? i}`;
                const previewKey = `${entry.file}:${entry.offset}`;
                const preview = responsePreviews.get(previewKey);

                return (
                  <div
                    key={cellKey}
                    className={`crispy-activity-path__cell${isMatch ? ' crispy-activity-path__cell--active' : ''}`}
                    data-row={i}
                    data-file={entry.file}
                    style={{ '--row-color': laneColorMap.get(entry.file) } as React.CSSProperties}
                    onClick={isMatch ? () => handleCellClick(lane) : undefined}
                  >
                    {isMatch && preview && (
                      <TruncatedCell text={preview} className="crispy-activity-path__response-text" />
                    )}
                    {isMatch && !preview && (
                      <span className="crispy-activity-path__cell-placeholder">···</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
