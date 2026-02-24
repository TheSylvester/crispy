/**
 * Active Tab Blocks Context — bridge between per-tab providers and sibling panels
 *
 * Per-tab providers (BlocksToolRegistryProvider, PanelStateProvider,
 * BlocksVisibilityProvider) live inside each TranscriptTab. Sibling
 * components like BlocksToolPanel sit outside the tab tree and need
 * access to the active tab's context. This bridge solves that:
 *
 * 1. ActiveTabBlocksProvider wraps the FlexLayout at FlexAppLayout level
 * 2. Each tab's ActiveTabBlocksBridge (rendered inside per-tab providers)
 *    writes the active tab's context values into the bridge when isActiveTab=true
 * 3. Consumer hooks use a two-level lookup: per-tab context -> bridge context
 *
 * This allows BlocksToolPanel to read from the active tab's registry without
 * needing to be nested inside every tab's provider tree.
 *
 * @module webview/blocks/ActiveTabBlocksContext
 */

import {
  createContext,
  useState,
  useCallback,
  type Dispatch,
  type ReactNode,
  type RefObject,
} from 'react';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';
import type { BlocksVisibilityStore } from './BlocksVisibilityContext.js';
import type { PanelState, PanelAction } from './types.js';
import { initialPanelState } from './panel-reducer.js';

// ============================================================================
// Context Value Types
// ============================================================================

const EMPTY_SET: ReadonlySet<string> = new Set();
const NOOP_DISPATCH: Dispatch<PanelAction> = () => {};
const NOOP_SET_DISPLAY: (ids: ReadonlySet<string>) => void = () => {};

export interface ActiveTabBlocksContextValue {
  registry: BlocksToolRegistry | null;
  sessionId: string | null;
  panelState: PanelState;
  panelDispatch: Dispatch<PanelAction>;
  panelDisplayIds: ReadonlySet<string>;
  setPanelDisplayIds: (ids: ReadonlySet<string>) => void;
  visibilityStore: BlocksVisibilityStore | null;
  scrollRef: RefObject<HTMLDivElement | null> | null;
}

interface ActiveTabBlocksSettersValue {
  setRegistry: (r: BlocksToolRegistry | null) => void;
  setSessionId: (id: string | null) => void;
  setPanelState: (s: PanelState) => void;
  setPanelDispatch: (d: Dispatch<PanelAction>) => void;
  setPanelDisplayIds: (setter: (ids: ReadonlySet<string>) => void) => void;
  setBridgePanelDisplayIds: (ids: ReadonlySet<string>) => void;
  setVisibilityStore: (s: BlocksVisibilityStore | null) => void;
  setScrollRef: (r: RefObject<HTMLDivElement | null> | null) => void;
}

// ============================================================================
// Contexts
// ============================================================================

/** Read context — consumed by hooks when outside per-tab providers */
export const ActiveTabBlocksCtx = createContext<ActiveTabBlocksContextValue | null>(null);

/** Write context — consumed by ActiveTabBlocksBridge inside per-tab providers */
export const ActiveTabBlocksSettersCtx = createContext<ActiveTabBlocksSettersValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface ActiveTabBlocksProviderProps {
  children: ReactNode;
}

/**
 * Provider that holds the active tab's context values.
 *
 * Wraps the FlexLayout at FlexAppLayout level. Children include both:
 * - FlexLayout tabs (which contain per-tab providers + ActiveTabBlocksBridge)
 * - BlocksToolPanel (which reads from this bridge context)
 */
export function ActiveTabBlocksProvider({
  children,
}: ActiveTabBlocksProviderProps): React.JSX.Element {
  const [registry, setRegistry] = useState<BlocksToolRegistry | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [panelState, setPanelState] = useState<PanelState>(initialPanelState);
  const [panelDispatch, setPanelDispatch] = useState<Dispatch<PanelAction>>(() => NOOP_DISPATCH);
  const [bridgePanelDisplayIds, setBridgePanelDisplayIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [setPanelDisplayIdsFn, setSetPanelDisplayIdsFn] = useState<(ids: ReadonlySet<string>) => void>(() => NOOP_SET_DISPLAY);
  const [visibilityStore, setVisibilityStore] = useState<BlocksVisibilityStore | null>(null);
  const [scrollRef, setScrollRef] = useState<RefObject<HTMLDivElement | null> | null>(null);

  // Stable setters for the bridge child
  const setters: ActiveTabBlocksSettersValue = {
    setRegistry: useCallback((r) => setRegistry(r), []),
    setSessionId: useCallback((id) => setSessionId(id), []),
    setPanelState: useCallback((s) => setPanelState(s), []),
    // Wrap dispatch in a function-returning-function to avoid React treating it as a reducer
    setPanelDispatch: useCallback((d) => setPanelDispatch(() => d), []),
    setPanelDisplayIds: useCallback((setter) => setSetPanelDisplayIdsFn(() => setter), []),
    setBridgePanelDisplayIds: useCallback((ids) => setBridgePanelDisplayIds(ids), []),
    setVisibilityStore: useCallback((s) => setVisibilityStore(s), []),
    setScrollRef: useCallback((r) => setScrollRef(r), []),
  };

  const value: ActiveTabBlocksContextValue = {
    registry,
    sessionId,
    panelState,
    panelDispatch,
    panelDisplayIds: bridgePanelDisplayIds,
    setPanelDisplayIds: setPanelDisplayIdsFn,
    visibilityStore,
    scrollRef,
  };

  return (
    <ActiveTabBlocksCtx.Provider value={value}>
      <ActiveTabBlocksSettersCtx.Provider value={setters}>
        {children}
      </ActiveTabBlocksSettersCtx.Provider>
    </ActiveTabBlocksCtx.Provider>
  );
}
