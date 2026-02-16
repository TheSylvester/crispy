/**
 * PerfStore — Mutable singleton metrics accumulator.
 *
 * Follows the ToolRegistry pattern: mutable state, subscribe()/getSnapshot()
 * for useSyncExternalStore, exposed as window.__CRISPY_PERF__ for console access.
 *
 * Hot paths (recordRender, recordScrollEvent) are zero-allocation.
 * Observers (MutationObserver, PerformanceObserver, rAF FPS, memory poll)
 * are started by init() and torn down by the returned cleanup function.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComponentMetrics {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface PerfSnapshot {
  // React renders
  components: Record<string, ComponentMetrics>;
  totalRenders: number;

  // DOM
  domNodeCount: number;
  longTaskCount: number;
  longTaskTotalMs: number;

  // Scroll
  fps: number;
  scrollEventCount: number;
  autoScrollTriggerCount: number;

  // Entries
  totalEntries: number;
  renderedEntries: number;
  blockCount: number;
  markdownRenderCount: number;
  markdownTotalMs: number;

  // Memory (Chrome only)
  heapUsedMB: number;
  heapTotalMB: number;

  // Tools
  toolCount: number;
  orphanCount: number;
}

type Listener = () => void;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class PerfStoreImpl {
  // --- React renders ---
  private components = new Map<string, ComponentMetrics>();
  private totalRenders = 0;

  // --- DOM ---
  private domNodeCount = 0;
  private longTaskCount = 0;
  private longTaskTotalMs = 0;

  // --- Scroll ---
  private fps = 0;
  private scrollEventCount = 0;
  private autoScrollTriggerCount = 0;

  // --- Entries ---
  private totalEntries = 0;
  private renderedEntries = 0;
  private blockCount = 0;
  private markdownRenderCount = 0;
  private markdownTotalMs = 0;

  // --- Memory ---
  private heapUsedMB = 0;
  private heapTotalMB = 0;

  // --- Tools ---
  private toolCount = 0;
  private orphanCount = 0;

  // --- FPS tracking ---
  private frameCount = 0;
  private lastFpsTime = 0;
  private rafId = 0;

  // --- Subscription ---
  private listeners = new Set<Listener>();
  private snapshot: PerfSnapshot | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Polled getters (injected at init) ---
  private getToolCountFn: (() => number) | null = null;
  private getOrphanCountFn: (() => number) | null = null;

  // =========================================================================
  // Recording (hot path — no allocations)
  // =========================================================================

  recordRender(id: string, durationMs: number): void {
    let m = this.components.get(id);
    if (!m) {
      m = { count: 0, totalMs: 0, maxMs: 0 };
      this.components.set(id, m);
    }
    m.count++;
    m.totalMs += durationMs;
    if (durationMs > m.maxMs) m.maxMs = durationMs;
    this.totalRenders++;
    // Notification is throttled via poll timer — no per-render notify
  }

  recordScrollEvent(): void {
    this.scrollEventCount++;
  }

  recordAutoScrollTrigger(): void {
    this.autoScrollTriggerCount++;
  }

  recordEntryStats(total: number, rendered: number, blocks: number): void {
    this.totalEntries = total;
    this.renderedEntries = rendered;
    this.blockCount = blocks;
  }

  recordMarkdownRender(durationMs: number): void {
    this.markdownRenderCount++;
    this.markdownTotalMs += durationMs;
  }

  // =========================================================================
  // useSyncExternalStore contract
  // =========================================================================

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): PerfSnapshot => {
    if (!this.snapshot) this.snapshot = this.buildSnapshot();
    return this.snapshot;
  };

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Inject tool-count getters (called from ToolRegistryContext once the
   * registry is available — decoupled from init() lifecycle).
   */
  setToolGetters(fns: {
    getToolCount: () => number;
    getOrphanCount: () => number;
  }): void {
    this.getToolCountFn = fns.getToolCount;
    this.getOrphanCountFn = fns.getOrphanCount;
  }

  /**
   * Start all observers. Returns a cleanup function.
   */
  init(): () => void {

    const cleanups: Array<() => void> = [];

    // --- DOM node count via MutationObserver (debounced 2s) ---
    let domTimer: ReturnType<typeof setTimeout> | null = null;
    const updateDomCount = () => {
      this.domNodeCount = document.querySelectorAll('*').length;
    };
    updateDomCount();
    const mo = new MutationObserver(() => {
      if (domTimer) clearTimeout(domTimer);
      domTimer = setTimeout(updateDomCount, 2000);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    cleanups.push(() => {
      mo.disconnect();
      if (domTimer) clearTimeout(domTimer);
    });

    // --- Long tasks via PerformanceObserver ---
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.longTaskCount++;
            this.longTaskTotalMs += entry.duration;
          }
        });
        po.observe({ type: 'longtask', buffered: true });
        cleanups.push(() => po.disconnect());
      } catch {
        // longtask not supported — ignore
      }
    }

    // --- FPS via rAF loop ---
    this.lastFpsTime = performance.now();
    this.frameCount = 0;
    const fpsLoop = (now: number) => {
      this.frameCount++;
      const elapsed = now - this.lastFpsTime;
      if (elapsed >= 1000) {
        this.fps = Math.round((this.frameCount * 1000) / elapsed);
        this.frameCount = 0;
        this.lastFpsTime = now;
      }
      this.rafId = requestAnimationFrame(fpsLoop);
    };
    this.rafId = requestAnimationFrame(fpsLoop);
    cleanups.push(() => cancelAnimationFrame(this.rafId));

    // --- 2s poll: memory + tool counts + snapshot refresh ---
    const pollId = setInterval(() => {
      // Memory (Chrome only)
      const mem = (performance as any).memory;
      if (mem) {
        this.heapUsedMB = Math.round(mem.usedJSHeapSize / 1048576);
        this.heapTotalMB = Math.round(mem.totalJSHeapSize / 1048576);
      }

      // Tool counts
      if (this.getToolCountFn) this.toolCount = this.getToolCountFn();
      if (this.getOrphanCountFn) this.orphanCount = this.getOrphanCountFn();

      // DOM count refresh (in case MutationObserver debounce lags)
      updateDomCount();

      // Invalidate snapshot and notify
      this.invalidate();
    }, 2000);
    cleanups.push(() => clearInterval(pollId));

    // --- 500ms snapshot refresh timer (throttle for useSyncExternalStore) ---
    this.notifyTimer = setInterval(() => {
      this.invalidate();
    }, 500);
    cleanups.push(() => {
      if (this.notifyTimer) clearInterval(this.notifyTimer);
    });

    // Expose for console
    (window as any).__CRISPY_PERF__ = this;

    return () => {
      cleanups.forEach((fn) => fn());
      delete (window as any).__CRISPY_PERF__;
    };
  }

  reset(): void {
    this.components.clear();
    this.totalRenders = 0;
    this.longTaskCount = 0;
    this.longTaskTotalMs = 0;
    this.scrollEventCount = 0;
    this.autoScrollTriggerCount = 0;
    this.markdownRenderCount = 0;
    this.markdownTotalMs = 0;
    this.totalEntries = 0;
    this.renderedEntries = 0;
    this.blockCount = 0;
    this.toolCount = 0;
    this.orphanCount = 0;
    this.invalidate();
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private buildSnapshot(): PerfSnapshot {
    const components: Record<string, ComponentMetrics> = {};
    for (const [id, m] of this.components) {
      components[id] = { count: m.count, totalMs: m.totalMs, maxMs: m.maxMs };
    }
    return {
      components,
      totalRenders: this.totalRenders,
      domNodeCount: this.domNodeCount,
      longTaskCount: this.longTaskCount,
      longTaskTotalMs: this.longTaskTotalMs,
      fps: this.fps,
      scrollEventCount: this.scrollEventCount,
      autoScrollTriggerCount: this.autoScrollTriggerCount,
      totalEntries: this.totalEntries,
      renderedEntries: this.renderedEntries,
      blockCount: this.blockCount,
      markdownRenderCount: this.markdownRenderCount,
      markdownTotalMs: this.markdownTotalMs,
      heapUsedMB: this.heapUsedMB,
      heapTotalMB: this.heapTotalMB,
      toolCount: this.toolCount,
      orphanCount: this.orphanCount,
    };
  }

  private invalidate(): void {
    this.snapshot = null;
    for (const cb of this.listeners) cb();
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const PerfStore = new PerfStoreImpl();
