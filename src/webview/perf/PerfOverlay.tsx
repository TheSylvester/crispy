/**
 * PerfOverlay — Floating metrics panel (top-right, z-index: 10000).
 * Renders only when isPerfMode is true.
 *
 * Features:
 * - Two-column layout: render stats (left) + runtime stats (right)
 * - Draggable title bar
 * - Collapsible (click title → single-line summary)
 * - [Reset] and [×] buttons
 * - Subscribes to PerfStore via useSyncExternalStore, throttled to 500ms
 */

import { useState, useRef, useCallback, useSyncExternalStore } from 'react';
import { PerfStore, type ComponentMetrics } from './profiler';

export function PerfOverlay(): React.JSX.Element | null {
  const snap = useSyncExternalStore(PerfStore.subscribe, PerfStore.getSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  const [visible, setVisible] = useState(true);
  const [pos, setPos] = useState({ x: -1, y: 8 }); // -1 = use CSS right:8px
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // --- Dragging ---
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const el = overlayRef.current;
    if (!el) return;

    // Convert right-anchored initial position to left-anchored
    const rect = el.getBoundingClientRect();
    const currentX = pos.x === -1 ? rect.left : pos.x;
    const currentY = pos.y;

    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: currentX, origY: currentY };

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [pos]);

  if (!visible) return null;

  // --- Top 5 hottest components ---
  const sorted = Object.entries(snap.components)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 5);

  const posStyle: React.CSSProperties = pos.x === -1
    ? { position: 'fixed', top: pos.y, right: 8, zIndex: 10000 }
    : { position: 'fixed', top: pos.y, left: pos.x, zIndex: 10000 };

  if (collapsed) {
    return (
      <div ref={overlayRef} className="crispy-perf-overlay crispy-perf-overlay--collapsed" style={posStyle}>
        <div className="crispy-perf-titlebar" onPointerDown={onPointerDown}>
          <span className="crispy-perf-title" onClick={() => setCollapsed(false)}>
            Perf
          </span>
          <span className="crispy-perf-summary">
            {snap.totalRenders} renders | {snap.domNodeCount} DOM | {snap.fps} fps
          </span>
          <button className="crispy-perf-btn" onClick={() => setVisible(false)} title="Close">×</button>
        </div>
      </div>
    );
  }

  return (
    <div ref={overlayRef} className="crispy-perf-overlay" style={posStyle}>
      <div className="crispy-perf-titlebar" onPointerDown={onPointerDown}>
        <span className="crispy-perf-title" onClick={() => setCollapsed(true)}>
          Perf Profiler
        </span>
        <span className="crispy-perf-actions">
          <button className="crispy-perf-btn" onClick={() => PerfStore.reset()} title="Reset counters">Reset</button>
          <button className="crispy-perf-btn" onClick={() => setVisible(false)} title="Close">×</button>
        </span>
      </div>

      <div className="crispy-perf-body">
        {/* Left column: React renders */}
        <div className="crispy-perf-col">
          <div className="crispy-perf-section-title">React Renders</div>
          <Row label="Total" value={snap.totalRenders} />
          <div className="crispy-perf-section-title" style={{ marginTop: 6 }}>Top Components</div>
          {sorted.length === 0 && <div className="crispy-perf-dim">No data yet</div>}
          {sorted.map(([id, m]) => (
            <ComponentRow key={id} id={id} m={m} />
          ))}
        </div>

        {/* Right column: Runtime stats */}
        <div className="crispy-perf-col">
          <div className="crispy-perf-section-title">DOM / Tasks</div>
          <Row label="DOM nodes" value={snap.domNodeCount} />
          <Row label="Long tasks" value={`${snap.longTaskCount} (${Math.round(snap.longTaskTotalMs)}ms)`} />

          <div className="crispy-perf-section-title" style={{ marginTop: 6 }}>Scroll</div>
          <Row label="FPS" value={snap.fps} />
          <Row label="Scroll events" value={snap.scrollEventCount} />
          <Row label="Auto-scroll" value={snap.autoScrollTriggerCount} />

          <div className="crispy-perf-section-title" style={{ marginTop: 6 }}>Entries / Blocks</div>
          <Row label="Entries" value={`${snap.renderedEntries} / ${snap.totalEntries}`} />
          <Row label="Blocks" value={snap.blockCount} />
          <Row label="MD renders" value={`${snap.markdownRenderCount} (${Math.round(snap.markdownTotalMs)}ms)`} />

          <div className="crispy-perf-section-title" style={{ marginTop: 6 }}>Memory</div>
          <Row label="Heap" value={snap.heapUsedMB ? `${snap.heapUsedMB} / ${snap.heapTotalMB} MB` : 'N/A'} />

          <div className="crispy-perf-section-title" style={{ marginTop: 6 }}>Tools</div>
          <Row label="Tools" value={snap.toolCount} />
          <Row label="Orphans" value={snap.orphanCount} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Row({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  return (
    <div className="crispy-perf-row">
      <span className="crispy-perf-label">{label}</span>
      <span className="crispy-perf-value">{String(value)}</span>
    </div>
  );
}

function ComponentRow({ id, m }: { id: string; m: ComponentMetrics }): React.JSX.Element {
  const avg = m.count > 0 ? (m.totalMs / m.count).toFixed(1) : '0';
  return (
    <div className="crispy-perf-row crispy-perf-component-row">
      <span className="crispy-perf-label" title={id}>{id}</span>
      <span className="crispy-perf-value">
        {m.count}× {Math.round(m.totalMs)}ms (avg {avg}ms)
      </span>
    </div>
  );
}
