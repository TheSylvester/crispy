/**
 * Visibility Tracker — IntersectionObserver-driven viewport sync for tool cards
 *
 * Tracks which tool cards (identified by `data-tool-id` attributes) are
 * currently visible in the transcript scroll viewport. The tool panel
 * consumes this to show only visible tools, creating a synchronized
 * "detail inspector" experience.
 *
 * Architecture:
 * - A single IntersectionObserver watches [data-tool-id] elements within
 *   the transcript scroll container
 * - A MutationObserver auto-discovers new [data-tool-id] elements as they
 *   stream into the DOM (new tools during streaming)
 * - Visible tool IDs are maintained in DOM order (top-to-bottom) via
 *   `useSyncExternalStore` for React integration
 * - Updates are batched with `requestAnimationFrame` to avoid per-element
 *   re-renders during fast scrolling
 *
 * @module webview/context/VisibilityContext
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  useCallback,
} from 'react';

// ============================================================================
// Store — pure TypeScript, no React dependency
// ============================================================================

class VisibilityStore {
  /** Currently visible tool IDs — maintained in DOM order */
  private _visibleIds: string[] = [];

  /** Set of currently visible tool IDs for O(1) lookup */
  private _visibleSet = new Set<string>();

  /** Subscribers (useSyncExternalStore pattern) */
  private _listeners = new Set<() => void>();

  /** RAF handle for batched updates */
  private _rafHandle: number | null = null;

  /** Pending visibility changes — batched before applying */
  private _pendingAdds = new Set<string>();
  private _pendingRemoves = new Set<string>();

  /** Reference to the scroll root for DOM ordering */
  private _scrollRoot: HTMLElement | null = null;

  setScrollRoot(root: HTMLElement | null): void {
    this._scrollRoot = root;
  }

  /** IntersectionObserver callback — batches changes via rAF */
  handleIntersection = (entries: IntersectionObserverEntry[]): void => {
    for (const entry of entries) {
      const toolId = (entry.target as HTMLElement).dataset.toolId;
      if (!toolId) continue;

      if (entry.isIntersecting) {
        this._pendingAdds.add(toolId);
        this._pendingRemoves.delete(toolId);
      } else {
        this._pendingRemoves.add(toolId);
        this._pendingAdds.delete(toolId);
      }
    }

    this.scheduleFlush();
  };

  /** Batch updates with requestAnimationFrame */
  private scheduleFlush(): void {
    if (this._rafHandle !== null) return;
    this._rafHandle = requestAnimationFrame(() => {
      this._rafHandle = null;
      this.flush();
    });
  }

  /** Apply pending changes and notify subscribers if set changed */
  private flush(): void {
    let changed = false;

    for (const id of this._pendingAdds) {
      if (!this._visibleSet.has(id)) {
        this._visibleSet.add(id);
        changed = true;
      }
    }
    for (const id of this._pendingRemoves) {
      if (this._visibleSet.has(id)) {
        this._visibleSet.delete(id);
        changed = true;
      }
    }

    this._pendingAdds.clear();
    this._pendingRemoves.clear();

    if (!changed) return;

    // Rebuild ordered list from DOM order
    this._visibleIds = this.sortByDomOrder([...this._visibleSet]);

    // Notify subscribers
    for (const cb of this._listeners) cb();
  }

  /** Sort tool IDs by their DOM order within the scroll root */
  private sortByDomOrder(ids: string[]): string[] {
    const root = this._scrollRoot;
    if (!root || ids.length <= 1) return ids;

    // Collect elements with their positions for sorting
    const withPosition: { id: string; top: number }[] = [];
    for (const id of ids) {
      const el = root.querySelector(`[data-tool-id="${id}"]`) as HTMLElement | null;
      if (el) {
        withPosition.push({ id, top: el.offsetTop });
      } else {
        // Element gone from DOM — include at end
        withPosition.push({ id, top: Infinity });
      }
    }

    withPosition.sort((a, b) => a.top - b.top);
    return withPosition.map(p => p.id);
  }

  // --- useSyncExternalStore interface ---

  subscribe = (cb: () => void): (() => void) => {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  };

  getSnapshot = (): string[] => {
    return this._visibleIds;
  };

  /** Reset on session change */
  reset(): void {
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
    this._pendingAdds.clear();
    this._pendingRemoves.clear();
    this._visibleSet.clear();
    this._visibleIds = [];
    for (const cb of this._listeners) cb();
  }

  destroy(): void {
    this.reset();
    this._listeners.clear();
  }
}

// ============================================================================
// React Context
// ============================================================================

const VisibilityCtx = createContext<VisibilityStore | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface VisibilityProviderProps {
  /** Ref to the .crispy-transcript scroll container */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}

export function VisibilityProvider({
  scrollRef,
  children,
}: VisibilityProviderProps): React.JSX.Element {
  const storeRef = useRef<VisibilityStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new VisibilityStore();
  }
  const store = storeRef.current;

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    store.setScrollRoot(scrollEl);

    // --- IntersectionObserver: watch [data-tool-id] elements ---
    // threshold: 0 means any pixel visible counts
    const io = new IntersectionObserver(store.handleIntersection, {
      root: scrollEl,
      threshold: 0,
    });

    // Observe existing [data-tool-id] elements
    const observeAll = () => {
      scrollEl.querySelectorAll('[data-tool-id]').forEach(el => {
        io.observe(el);
      });
    };

    observeAll();

    // --- MutationObserver: auto-discover new [data-tool-id] elements ---
    const mo = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          // Check the node itself
          if (node.dataset.toolId) {
            io.observe(node);
          }
          // Check descendants
          node.querySelectorAll('[data-tool-id]').forEach(desc => {
            io.observe(desc);
          });
        });
      }
    });

    mo.observe(scrollEl, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
      store.reset();
    };
  }, [scrollRef, store]);

  return (
    <VisibilityCtx.Provider value={store}>
      {children}
    </VisibilityCtx.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Subscribe to the list of currently visible tool IDs (in DOM order).
 * Returns an empty array if no tools are visible or if used outside
 * the provider.
 */
export function useVisibleToolIds(): string[] {
  const store = useContext(VisibilityCtx);

  const subscribe = useCallback(
    (cb: () => void) => store ? store.subscribe(cb) : () => {},
    [store],
  );

  const getSnapshot = useCallback(
    () => store ? store.getSnapshot() : EMPTY,
    [store],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}

const EMPTY: string[] = [];
