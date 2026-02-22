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
 * Provider wraps the blocks branch of TranscriptViewer, between
 * BlocksToolRegistryProvider and BlocksVisibilityProvider.
 *
 * @module webview/blocks/PanelStateContext
 */

import { createContext, useContext, useReducer, useState, useCallback, type Dispatch, type ReactNode } from 'react';
import { panelReducer, initialPanelState } from './panel-reducer.js';
import type { PanelState, PanelAction } from './types.js';

// ============================================================================
// Contexts
// ============================================================================

const PanelStateCtx = createContext<PanelState>(initialPanelState);
const PanelDispatchCtx = createContext<Dispatch<PanelAction>>(() => {});

/** Set of tool IDs currently displayed in the tool panel */
const EMPTY_SET: ReadonlySet<string> = new Set();
const PanelDisplayCtx = createContext<ReadonlySet<string>>(EMPTY_SET);
const SetPanelDisplayCtx = createContext<(ids: ReadonlySet<string>) => void>(() => {});

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
// Hooks
// ============================================================================

export function usePanelState(): PanelState {
  return useContext(PanelStateCtx);
}

export function usePanelDispatch(): Dispatch<PanelAction> {
  return useContext(PanelDispatchCtx);
}

/** Read the set of tool IDs currently displayed in the tool panel. */
export function usePanelDisplayIds(): ReadonlySet<string> {
  return useContext(PanelDisplayCtx);
}

/** Set the panel display IDs (called by BlocksToolPanel). */
export function useSetPanelDisplayIds(): (ids: ReadonlySet<string>) => void {
  return useContext(SetPanelDisplayCtx);
}
