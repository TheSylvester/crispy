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
 * Provider wraps per-tab inside FlexTranscriptContent. Hooks fall back to
 * the ActiveTabBlocksContext bridge when consumed outside the provider
 * (e.g., by BlocksToolPanel in the inspector border tab).
 *
 * @module webview/blocks/PanelStateContext
 */

import { createContext, useContext, useReducer, useState, useCallback, type Dispatch, type ReactNode } from 'react';
import { panelReducer, initialPanelState } from './panel-reducer.js';
import type { PanelState, PanelAction } from './types.js';
import { ActiveTabBlocksCtx } from './ActiveTabBlocksContext.js';

// ============================================================================
// Contexts
// ============================================================================

const PanelStateCtx = createContext<PanelState>(initialPanelState);
const PanelDispatchCtx = createContext<Dispatch<PanelAction>>(() => {});

/** Set of tool IDs currently displayed in the tool panel */
const EMPTY_SET: ReadonlySet<string> = new Set();
const PanelDisplayCtx = createContext<ReadonlySet<string>>(EMPTY_SET);
const SetPanelDisplayCtx = createContext<(ids: ReadonlySet<string>) => void>(() => {});

/**
 * Sentinel context: true when inside a PanelStateProvider.
 * Required to distinguish "inside provider with default state" from "outside provider"
 * since PanelStateCtx default is initialPanelState (not null).
 */
const InsidePanelProviderCtx = createContext(false);

// ============================================================================
// Provider
// ============================================================================

export function PanelStateProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  const [displayIds, setDisplayIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const stableSetDisplayIds = useCallback((ids: ReadonlySet<string>) => setDisplayIds(ids), []);
  return (
    <InsidePanelProviderCtx.Provider value={true}>
      <PanelStateCtx.Provider value={state}>
        <PanelDispatchCtx.Provider value={dispatch}>
          <PanelDisplayCtx.Provider value={displayIds}>
            <SetPanelDisplayCtx.Provider value={stableSetDisplayIds}>
              {children}
            </SetPanelDisplayCtx.Provider>
          </PanelDisplayCtx.Provider>
        </PanelDispatchCtx.Provider>
      </PanelStateCtx.Provider>
    </InsidePanelProviderCtx.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

const NOOP_DISPATCH: Dispatch<PanelAction> = () => {};
const NOOP_SET_DISPLAY: (ids: ReadonlySet<string>) => void = () => {};

/**
 * Get the panel expansion state.
 * Falls back to bridge context when outside a PanelStateProvider.
 */
export function usePanelState(): PanelState {
  const inside = useContext(InsidePanelProviderCtx);
  const ctx = useContext(PanelStateCtx);
  const bridge = useContext(ActiveTabBlocksCtx);
  return inside ? ctx : (bridge?.panelState ?? initialPanelState);
}

/**
 * Get the panel dispatch function.
 * Falls back to bridge context when outside a PanelStateProvider.
 */
export function usePanelDispatch(): Dispatch<PanelAction> {
  const inside = useContext(InsidePanelProviderCtx);
  const ctx = useContext(PanelDispatchCtx);
  const bridge = useContext(ActiveTabBlocksCtx);
  return inside ? ctx : (bridge?.panelDispatch ?? NOOP_DISPATCH);
}

/**
 * Read the set of tool IDs currently displayed in the tool panel.
 * Falls back to bridge context when outside a PanelStateProvider.
 */
export function usePanelDisplayIds(): ReadonlySet<string> {
  const inside = useContext(InsidePanelProviderCtx);
  const ctx = useContext(PanelDisplayCtx);
  const bridge = useContext(ActiveTabBlocksCtx);
  return inside ? ctx : (bridge?.panelDisplayIds ?? EMPTY_SET);
}

/**
 * Set the panel display IDs (called by BlocksToolPanel).
 * Falls back to bridge context when outside a PanelStateProvider.
 */
export function useSetPanelDisplayIds(): (ids: ReadonlySet<string>) => void {
  const inside = useContext(InsidePanelProviderCtx);
  const ctx = useContext(SetPanelDisplayCtx);
  const bridge = useContext(ActiveTabBlocksCtx);
  return inside ? ctx : (bridge?.setPanelDisplayIds ?? NOOP_SET_DISPLAY);
}
