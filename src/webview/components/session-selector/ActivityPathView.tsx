/**
 * ActivityPathView — Chronological user activity across all sessions
 *
 * Displays a 3-column layout: TIME | YOUR PROMPT | RESPONSE.
 * The response column multiplexes all sessions into a single chameleon
 * column — at rest each row shows a colored dot (per-session lane color),
 * and on hover the response text is revealed while the header morphs to
 * show the hovered session's identity. All hover effects are zero-React-
 * render via direct DOM class toggles and ref updates.
 *
 * @module ActivityPathView
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import { useSession } from '../../context/SessionContext.js';
import { usePreferences } from '../../context/PreferencesContext.js';
import type { ActivityIndexEntry } from '../../../core/activity-index.js';
import type { WireSessionInfo } from '../../transport.js';
import { getSessionDisplayName } from '../../utils/session-display.js';

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
// Helpers
// ============================================================================

function formatTime(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const suffix = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}${suffix}`;
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

/** Deterministic color index from file path (hash-based, not order-based) */
function fileColorIndex(file: string): number {
  let h = 0;
  for (let i = 0; i < file.length; i++) {
    h = ((h << 5) - h + file.charCodeAt(i)) | 0;
  }
  return ((h % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length;
}

// ============================================================================
// TruncatedCell — stateless wrapper with native title tooltip (zero JS cost)
// ============================================================================

function TruncatedCell({ text, className }: { text: string; className?: string }) {
  // Append ellipsis when the preview appears truncated (no terminal punctuation)
  const display = text && !/[.!?…)\]]$/.test(text.trimEnd()) ? text + '…' : text;
  return (
    <div className={`crispy-activity-path__truncated ${className ?? ''}`} title={text}>
      <span className="crispy-activity-path__clamp">{display}</span>
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

  // ---- Build session map & derived lookups ----
  const sessionMap = useMemo(() => {
    const map = new Map<string, WireSessionInfo>();
    for (const s of sessions) {
      if (s.path) map.set(s.path, s);
    }
    return map;
  }, [sessions]);

  // Per-file color assignment (hash-based — deterministic regardless of sort order)
  const laneColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      if (!map.has(e.file)) {
        map.set(e.file, LANE_COLORS[fileColorIndex(e.file)]);
      }
    }
    return map;
  }, [entries]);

  // Per-file index for staircase indent (sorted by most recent activity)
  const laneIndexMap = useMemo(() => {
    const fileActivity = new Map<string, string>();
    for (const e of entries) {
      const existing = fileActivity.get(e.file);
      if (!existing || e.timestamp > existing) {
        fileActivity.set(e.file, e.timestamp);
      }
    }
    const sorted = [...fileActivity.entries()].sort((a, b) => b[1].localeCompare(a[1]));
    const map = new Map<string, number>();
    sorted.forEach(([file], i) => map.set(file, i));
    return map;
  }, [entries]);

  // Per-file human-readable label (for response header on hover)
  const fileLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      if (map.has(e.file)) continue;
      const session = sessionMap.get(e.file);
      map.set(e.file, session
        ? getSessionDisplayName(session)
        : e.file.split('/').pop()?.replace('.jsonl', '') || e.file);
    }
    return map;
  }, [entries, sessionMap]);

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
  const handleEntryClick = useCallback((file: string) => {
    const session = sessionMap.get(file);
    if (session) {
      setSelectedSessionId(session.sessionId);
      setTimeout(() => setSidebarCollapsed(true), 200);
    }
  }, [sessionMap, setSelectedSessionId, setSidebarCollapsed]);

  // ---- Scroll management ----
  const matrixRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on initial load (newest entries are at the bottom)
  const didScrollRef = useRef(false);
  useEffect(() => {
    if (!loading && paginatedEntries.length > 0 && !didScrollRef.current) {
      didScrollRef.current = true;
      // Double-rAF: give the browser two full frames to finalize sticky layout
      // calculations before the programmatic scroll forces a recalculation.
      // In deeply nested layouts (absolute dropdown → overflow:hidden → overflow:auto),
      // a single rAF isn't always enough.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          matrixRef.current?.scrollTo({ top: matrixRef.current.scrollHeight });
        });
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
  const responseHeaderRef = useRef<HTMLSpanElement>(null);

  const clearHighlights = useCallback(() => {
    if (!hoverRef.current) return;
    for (const el of hoverRef.current.els) {
      el.classList.remove(
        'crispy-activity-path__row--highlighted',
        'crispy-activity-path__row--sibling',
      );
    }
    // Reset response header to empty state
    const headerEl = responseHeaderRef.current;
    if (headerEl) {
      headerEl.textContent = '';
      // --lane-color lives on the outer div (flex item), not the inner span
      const outer = headerEl.parentElement;
      if (outer) outer.style.removeProperty('--lane-color');
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

    // Row highlight: all elements with matching data-row get highlighted
    for (const el of Array.from(matrix.querySelectorAll(`[data-row="${CSS.escape(row)}"]`))) {
      el.classList.add('crispy-activity-path__row--highlighted');
      els.push(el);
    }

    // Sibling highlight: same file, different row
    const siblingSelector = `[data-file="${CSS.escape(file)}"]:not([data-row="${CSS.escape(row)}"])`;
    for (const el of Array.from(matrix.querySelectorAll(siblingSelector))) {
      if (el.classList.contains('crispy-activity-path__time-row') ||
          el.classList.contains('crispy-activity-path__prompt-row') ||
          el.classList.contains('crispy-activity-path__response-row')) {
        el.classList.add('crispy-activity-path__row--sibling');
        els.push(el);
      }
    }

    // Update response header with hovered session's identity
    const headerEl = responseHeaderRef.current;
    if (headerEl) {
      headerEl.textContent = fileLabelMap.get(file) ?? '';
      // --lane-color drives border/background on the outer div, not the inner span
      const outer = headerEl.parentElement;
      if (outer) outer.style.setProperty('--lane-color', laneColorMap.get(file) ?? '');
    }

    hoverRef.current = { row, file, els };
  }, [clearHighlights, fileLabelMap, laneColorMap]);

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
      <div
        className="crispy-activity-path__matrix"
        ref={matrixRef}
        onMouseOver={handleMatrixPointer}
        onMouseLeave={clearHighlights}
      >
        {/* Sticky header row — flat, outside column wrappers so sticky-top
            isn't bounded by a sticky-left parent's containing block */}
        <div className="crispy-activity-path__header-row">
          <div className="crispy-activity-path__header crispy-activity-path__header--time">
            Time
          </div>
          <div className="crispy-activity-path__header crispy-activity-path__header--prompts">
            Your Prompt
          </div>
          <div className="crispy-activity-path__header crispy-activity-path__header--response">
            <span
              className="crispy-activity-path__header--response-text"
              ref={responseHeaderRef}
            />
          </div>
        </div>

        {/* Body — row-flex container wrapping the data columns */}
        <div className="crispy-activity-path__body">
          {/* TIME column (sticky left:0) */}
          <div className="crispy-activity-path__time-col">
            {hasMore && (
              <div className="crispy-activity-path__time-row crispy-activity-path__load-more-spacer" />
            )}
            {paginatedEntries.map((entry, i) => {
              const isClickable = !!sessionMap.get(entry.file);
              return (
                <div
                  key={`time-${entry.timestamp}-${entry.uuid ?? i}`}
                  className="crispy-activity-path__time-row"
                  data-row={i}
                  data-file={entry.file}
                  onClick={isClickable ? () => handleEntryClick(entry.file) : undefined}
                  style={{ cursor: isClickable ? 'pointer' : undefined, '--lane-color': laneColorMap.get(entry.file) } as React.CSSProperties}
                >
                  <span className="crispy-activity-path__date">{formatDate(entry.timestamp)}</span>
                  <span className="crispy-activity-path__clock">{formatTime(entry.timestamp)}</span>
                </div>
              );
            })}
          </div>

          {/* PROMPT column (sticky left:52px) */}
          <div className="crispy-activity-path__prompt-col">
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
              const isClickable = !!sessionMap.get(entry.file);
              return (
                <div
                  key={`prompt-${entry.timestamp}-${entry.uuid ?? i}`}
                  className="crispy-activity-path__prompt-row"
                  data-row={i}
                  data-file={entry.file}
                  onClick={isClickable ? () => handleEntryClick(entry.file) : undefined}
                  style={{ cursor: isClickable ? 'pointer' : undefined, '--lane-color': laneColorMap.get(entry.file), '--lane-indent': `${(laneIndexMap.get(entry.file) ?? 0) * 6}px` } as React.CSSProperties}
                >
                  <TruncatedCell text={entry.preview} className="crispy-activity-path__prompt-text" />
                </div>
              );
            })}
          </div>

          {/* RESPONSE column (flex-fill) */}
          <div className="crispy-activity-path__response-col">
            {hasMore && (
              <div className="crispy-activity-path__response-row crispy-activity-path__load-more-spacer" />
            )}
            {paginatedEntries.map((entry, i) => {
              const previewKey = `${entry.file}:${entry.offset}`;
              const preview = responsePreviews.get(previewKey);
              const isClickable = !!sessionMap.get(entry.file);

              return (
                <div
                  key={`resp-${entry.timestamp}-${entry.uuid ?? i}`}
                  className="crispy-activity-path__response-row"
                  data-row={i}
                  data-file={entry.file}
                  onClick={isClickable ? () => handleEntryClick(entry.file) : undefined}
                  style={{ cursor: isClickable ? 'pointer' : undefined, '--lane-color': laneColorMap.get(entry.file) } as React.CSSProperties}
                >
                  {preview && (
                    <TruncatedCell text={preview} className="crispy-activity-path__response-text" />
                  )}
                  {preview === undefined && (
                    <span className="crispy-activity-path__cell-placeholder">···</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
