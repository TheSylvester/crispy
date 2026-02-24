/**
 * Panel State Context — shared reducer context for tool panel expansion state
 *
 * Lifts the panel reducer out of BlocksToolPanel so both the transcript
 * (click handlers on compact tools) and the panel can dispatch actions.
 *
 * Also provides the panel display set — the set of tool IDs currently
 * rendered in the tool panel. BlocksToolPanel publishes into this set;
 * ToolBlockRenderer reads it for the panel-active highlight.
 *
 * Provider wraps per-tab inside TranscriptTab. Hooks fall back to
 * the ActiveTabBlocksContext bridge when consumed outside the provider
 * (e.g., by BlocksToolPanel in the inspector border tab).
 *
 * Two-level lookup: per-tab context (non-null) -> bridge context.
 * No empty fallbacks — if neither is available, something is structurally wrong.
 *
 * @module webview/blocks/PanelStateContext
 */

import { createContext, useContext, useReducer, useState, useCallback, type Dispatch, type ReactNode } from 'react';
import { panelReducer, initialPanelState } from './panel-reducer.js';
import type { PanelState, PanelAction } from './types.js';
import { ActiveTabBlocksCtx } from './ActiveTabBlocksContext.js';

// ============================================================================
// Contexts — null defaults distinguish "inside provider" from "outside"
// ============================================================================

const PanelStateCtx = createContext<PanelState | null>(null);
const PanelDispatchCtx = createContext<Dispatch<PanelAction> | null>(null);

/** Set of tool IDs currently displayed in the tool panel */
const EMPTY_SET: ReadonlySet<string> = new Set();
const PanelDisplayCtx = createContext<ReadonlySet<string> | null>(null);
const SetPanelDisplayCtx = createContext<((ids: ReadonlySet<string>) => void) | null>(null);

// ============================================================================
// Provider
// ============================================================================

export function PanelStateProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  const [displayIds, setDisplayIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const stableSetDisplayIds = useCallback((ids: ReadonlySet<string>) => setDisplayIds(ids), []);
  return (
    <PanelStateCtx.Provider value={state}>
      <PanelDispatchCtx.Provider value={dispatch}>
        <PanelDisplayCtx.Provider value={displayIds}>
          <SetPanelDisplayCtx.Provider value={stableSetDisplayIds}>
            {children}
          </SetPanelDisplayCtx.Provider>
        </PanelDisplayCtx.Provider>
      </PanelDispatchCtx.Provider>
    </PanelStateCtx.Provider>
  );
}

// ============================================================================
// Hooks — two-level lookup: per-tab context -> bridge context
// ============================================================================

/**
 * Get the panel expansion state.
 * Per-tab context first, bridge fallback second.
 */
export function usePanelState(): PanelState {
  const ctx = useContext(PanelStateCtx);
  const bridge = useContext(ActiveTabBlocksCtx);
  return ctx ?? bridge?.panelState ?? initialPanelState;
}

/**
 * Get the panel dispatch function.
 * Per-tab context first, bridge fallback second.
 */
export function usePanelDispatch(): Dispatch<PanelAction> {
  const ctx = useContext(PanelDispatchCtx);
  const bridge = useContext(ActiveTabBlocksCtx);
  if (ctx) return ctx;
  if (bridge?.panelDispatch) return bridge.panelDispatch;
  throw new Error('usePanelDispatch: no PanelStateProvider or ActiveTabBlocksBridge ancestor');
}

/**
 * Read the set of tool IDs currently displayed in the tool panel.
 * Per-tab context first, bridge fallback second.
 */
export function usePanelDisplayIds(): ReadonlySet<string> {
  const ctx = useContext(PanelDisplayCtx);
  const bridge = useContext(ActiveTabBlocksCtx);
  return ctx ?? bridge?.panelDisplayIds ?? EMPTY_SET;
}

/**
 * Set the panel display IDs (called by BlocksToolPanel).
 * Per-tab context first, bridge fallback second.
 */
export function useSetPanelDisplayIds(): (ids: ReadonlySet<string>) => void {
  const ctx = useContext(SetPanelDisplayCtx);
  const bridge = useContext(ActiveTabBlocksCtx);
  if (ctx) return ctx;
  if (bridge?.setPanelDisplayIds) return bridge.setPanelDisplayIds;
  throw new Error('useSetPanelDisplayIds: no PanelStateProvider or ActiveTabBlocksBridge ancestor');
}
