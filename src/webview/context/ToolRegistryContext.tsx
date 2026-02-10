/**
 * Tool Registry Context — React integration for the ToolRegistry
 *
 * Follows the SessionContext pattern: named context → Provider function →
 * useXxx hooks with null guard + throw.
 *
 * The provider owns a ToolRegistry singleton (via useRef) and processes
 * transcript entries **synchronously during render** — not in a useEffect.
 * This is critical: child components read from the registry via
 * useSyncExternalStore's getSnapshot(), which runs during render. If we
 * populated the registry in a post-render effect, the first paint would
 * show text blocks but null tool cards (registry empty → useToolEntry
 * returns undefined → tool renderers return null).
 *
 * Processing during render is safe because:
 * - The registry is a mutable ref (useRef), not React state
 * - We guard with processedCountRef to avoid reprocessing
 * - Notifications are suppressed (silent mode) during render to avoid
 *   triggering useSyncExternalStore re-render cascades mid-render
 *
 * @module webview/context/ToolRegistryContext
 */

import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
  useCallback,
} from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import { ToolRegistry, processEntryForRegistry } from '../tool-registry.js';
import type { ToolEntry } from '../tool-registry.js';

// ============================================================================
// Context
// ============================================================================

const ToolRegistryCtx = createContext<ToolRegistry | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface ToolRegistryProviderProps {
  entries: TranscriptEntry[];
  sessionId: string | null;
  children: React.ReactNode;
}

export function ToolRegistryProvider({
  entries,
  sessionId,
  children,
}: ToolRegistryProviderProps): React.JSX.Element {
  const registryRef = useRef<ToolRegistry | null>(null);
  if (registryRef.current === null) {
    registryRef.current = new ToolRegistry();
  }
  const registry = registryRef.current;

  const processedCountRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Synchronous render-phase processing
  //
  // This block runs during render (not in useEffect) so the registry is
  // populated BEFORE children call useToolEntry(). We use silent mode to
  // suppress subscriber notifications — children will pick up the current
  // state via getSnapshot() during their own render, so notifications are
  // unnecessary and would cause wasteful re-render cascades.
  // ---------------------------------------------------------------------------

  const sessionChanged = sessionId !== sessionIdRef.current;
  if (sessionChanged) {
    sessionIdRef.current = sessionId;
    registry.reset({ silent: true });
    processedCountRef.current = 0;
  }

  const len = entries.length;
  const processed = processedCountRef.current;

  if (len === 0) {
    // Nothing to process — reset if we had state (handles session → null)
    if (processed > 0) {
      registry.reset({ silent: true });
      processedCountRef.current = 0;
    }
  } else if (len > processed) {
    // Forward append: initial session load, live streaming, or step-forward.
    // Use silent mode to suppress notifications during render — children
    // will read the populated registry via getSnapshot().
    registry.silent(() => {
      for (let i = processed; i < len; i++) {
        processEntryForRegistry(entries[i], registry);
      }
    });
    processedCountRef.current = len;
  } else if (len < processed) {
    // Playback rewind — full reset + reprocess
    registry.reset({ silent: true });
    registry.silent(() => {
      for (const entry of entries) {
        processEntryForRegistry(entry, registry);
      }
    });
    processedCountRef.current = len;
  }
  // len === processed && !sessionChanged → no new entries, nothing to do

  return (
    <ToolRegistryCtx.Provider value={registry}>
      {children}
    </ToolRegistryCtx.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Access the ToolRegistry instance. Throws if used outside ToolRegistryProvider.
 */
export function useToolRegistry(): ToolRegistry {
  const ctx = useContext(ToolRegistryCtx);
  if (!ctx) {
    throw new Error('useToolRegistry must be used within a ToolRegistryProvider');
  }
  return ctx;
}

/**
 * Subscribe to a single tool entry by id. Returns undefined if the tool
 * hasn't been registered yet. Re-renders only when this specific entry changes.
 */
export function useToolEntry(id: string): ToolEntry | undefined {
  const registry = useToolRegistry();

  const subscribe = useCallback(
    (cb: () => void) => registry.subscribeTool(id, cb),
    [registry, id],
  );

  const getSnapshot = useCallback(
    () => registry.getToolEntry(id),
    [registry, id],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Subscribe to the list of root tool IDs (tools with no parent).
 * Re-renders only when the root list changes structurally.
 */
export function useToolRoots(): string[] {
  const registry = useToolRegistry();

  const subscribe = useCallback(
    (cb: () => void) => registry.subscribeGlobal(cb),
    [registry],
  );

  const getSnapshot = useCallback(
    () => registry.getRootToolIds(),
    [registry],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
