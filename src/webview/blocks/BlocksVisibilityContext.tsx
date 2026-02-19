/**
 * Blocks Visibility Context — run-level IntersectionObserver for blocks mode
 *
 * Tracks which runs (and their contained tools) are currently visible in the
 * transcript scroll viewport. Simplified version of VisibilityContext that
 * watches `[data-run-id]` elements instead of individual tools.
 *
 * For collapsed groups, reads `data-tool-ids` to expand visibility to all
 * tool IDs within the group.
 *
 * Architecture:
 * - A single IntersectionObserver watches [data-run-id] elements
 * - A MutationObserver auto-discovers new run elements as they stream in
 * - Visible tool IDs are maintained in DOM order via useSyncExternalStore
 * - Updates are batched with requestAnimationFrame
 *
 * @module webview/blocks/BlocksVisibilityContext
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

class BlocksVisibilityStore {
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
      const el = entry.target as HTMLElement;

      // Extract tool IDs from the run element
      // Single tool: data-run-id is the tool ID
      // Collapsed group: data-tool-ids contains comma-separated IDs
      const toolIds = el.dataset.toolIds
        ? el.dataset.toolIds.split(',')
        : el.dataset.runId
          ? [el.dataset.runId]
          : [];

      if (toolIds.length === 0) continue;

      for (const toolId of toolIds) {
        if (entry.isIntersecting) {
          this._pendingAdds.add(toolId);
          this._pendingRemoves.delete(toolId);
        } else {
          this._pendingRemoves.add(toolId);
          this._pendingAdds.delete(toolId);
        }
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
      // Try single run first
      let el = root.querySelector(`[data-run-id="${id}"]`) as HTMLElement | null;

      // If not found, search in collapsed groups
      if (!el) {
        const groupEls = root.querySelectorAll('[data-tool-ids]');
        groupEls.forEach(ge => {
          if (el) return; // Already found
          const idsAttr = (ge as HTMLElement).dataset.toolIds;
          if (idsAttr && idsAttr.split(',').includes(id)) {
            el = ge as HTMLElement;
          }
        });
      }

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

  /** Check if a tool is currently visible */
  isVisible(toolId: string): boolean {
    return this._visibleSet.has(toolId);
  }

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

const BlocksVisibilityCtx = createContext<BlocksVisibilityStore | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface BlocksVisibilityProviderProps {
  /** Ref to the .crispy-transcript scroll container */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}

export function BlocksVisibilityProvider({
  scrollRef,
  children,
}: BlocksVisibilityProviderProps): React.JSX.Element {
  const storeRef = useRef<BlocksVisibilityStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new BlocksVisibilityStore();
  }
  const store = storeRef.current;

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    store.setScrollRoot(scrollEl);

    // --- IntersectionObserver: watch [data-run-id] elements ---
    // threshold: 0 means any pixel visible counts
    const io = new IntersectionObserver(store.handleIntersection, {
      root: scrollEl,
      threshold: 0,
    });

    // Observe existing run elements
    const observeAll = () => {
      // Observe collapsed groups (have data-tool-ids)
      scrollEl.querySelectorAll('[data-tool-ids]').forEach(el => {
        io.observe(el);
      });
      // Observe single runs (have data-run-id)
      scrollEl.querySelectorAll('[data-run-id]').forEach(el => {
        io.observe(el);
      });
    };

    observeAll();

    // --- MutationObserver: auto-discover new run elements ---
    const mo = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          // Check the node itself
          if (node.dataset.toolIds || node.dataset.runId) {
            io.observe(node);
          }
          // Check descendants
          node.querySelectorAll('[data-tool-ids]').forEach(desc => {
            io.observe(desc);
          });
          node.querySelectorAll('[data-run-id]').forEach(desc => {
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
    <BlocksVisibilityCtx.Provider value={store}>
      {children}
    </BlocksVisibilityCtx.Provider>
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
export function useBlocksVisibleToolIds(): string[] {
  const store = useContext(BlocksVisibilityCtx);

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

/**
 * Check if a specific tool is currently visible.
 */
export function useBlocksToolVisible(toolId: string): boolean {
  const visibleIds = useBlocksVisibleToolIds();
  return visibleIds.includes(toolId);
}

const EMPTY: string[] = [];
