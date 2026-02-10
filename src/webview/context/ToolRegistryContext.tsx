/**
 * Tool Registry Context — React integration for the ToolRegistry
 *
 * Follows the SessionContext pattern: named context → Provider function →
 * useXxx hooks with null guard + throw.
 *
 * The provider owns a ToolRegistry singleton (via useRef), processes
 * transcript entries incrementally (live streaming) or in batch (session
 * load / playback rewind), and exposes subscription-based hooks powered
 * by useSyncExternalStore.
 *
 * @module webview/context/ToolRegistryContext
 */

import {
  createContext,
  useContext,
  useRef,
  useEffect,
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

  // Unified effect: handles session changes AND entry processing in one pass.
  // Merging avoids a race where sessionId changes but entries haven't caught up
  // yet (useTranscript loads asynchronously), which would cause stale entries
  // from the previous session to be processed into the fresh registry.
  useEffect(() => {
    const sessionChanged = sessionId !== sessionIdRef.current;
    if (sessionChanged) {
      sessionIdRef.current = sessionId;
      registry.reset();
      processedCountRef.current = 0;
    }

    const len = entries.length;
    const processed = processedCountRef.current;

    if (len === 0) {
      // Nothing to process — reset if we had state (handles session → null)
      if (processed > 0) {
        registry.reset();
        processedCountRef.current = 0;
      }
      return;
    }

    if (len > processed) {
      // Incremental append (live streaming or step-forward).
      // On session change, processed is 0, so this processes all entries.
      for (let i = processed; i < len; i++) {
        processEntryForRegistry(entries[i], registry);
      }
    } else if (len < processed) {
      // Playback rewind — full reset + rebatch
      registry.reset();
      registry.batch(() => {
        for (const entry of entries) {
          processEntryForRegistry(entry, registry);
        }
      });
    }
    // len === processed && !sessionChanged → no new entries, nothing to do

    processedCountRef.current = len;
  }, [entries, entries.length, sessionId, registry]);

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
