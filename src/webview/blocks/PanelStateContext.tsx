/**
 * Panel State Context — shared reducer context for tool panel expansion state
 *
 * Lifts the panel reducer out of BlocksToolPanel so both the transcript
 * (click handlers on compact tools) and the panel can dispatch actions.
 *
 * Provider wraps the blocks branch of TranscriptViewer, between
 * BlocksToolRegistryProvider and BlocksVisibilityProvider.
 *
 * @module webview/blocks/PanelStateContext
 */

import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import { panelReducer, initialPanelState } from './panel-reducer.js';
import type { PanelState, PanelAction } from './types.js';

// ============================================================================
// Contexts
// ============================================================================

const PanelStateCtx = createContext<PanelState>(initialPanelState);
const PanelDispatchCtx = createContext<Dispatch<PanelAction>>(() => {});

// ============================================================================
// Provider
// ============================================================================

export function PanelStateProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  return (
    <PanelStateCtx.Provider value={state}>
      <PanelDispatchCtx.Provider value={dispatch}>
        {children}
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
