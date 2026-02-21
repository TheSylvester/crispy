/**
 * Panel Reducer — state management for the blocks tool panel
 *
 * Simple two-field model:
 * - autoExpandedIds: system-suggested expansions (streaming tools)
 * - userOverrides: explicit user clicks (always wins over auto)
 *
 * Click behavior is a pure toggle — no priority cascades, no branching
 * based on *why* a tool is expanded.
 *
 * @module webview/blocks/panel-reducer
 */

import type { PanelAction, PanelState } from './types.js';

// ============================================================================
// Initial State
// ============================================================================

export const initialPanelState: PanelState = {
  autoExpandedIds: new Set(),
  userOverrides: new Map(),
};

// ============================================================================
// Reducer
// ============================================================================

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'AUTO_EXPAND': {
      if (state.autoExpandedIds.has(action.toolId)) return state;
      return {
        ...state,
        autoExpandedIds: new Set([...state.autoExpandedIds, action.toolId]),
      };
    }

    case 'TOOL_LEFT_VIEW': {
      const hadAuto = state.autoExpandedIds.has(action.toolId);
      const hadOverride = state.userOverrides.has(action.toolId);
      if (!hadAuto && !hadOverride) return state;

      const next = { ...state };
      if (hadAuto) {
        const s = new Set(state.autoExpandedIds);
        s.delete(action.toolId);
        next.autoExpandedIds = s;
      }
      if (hadOverride) {
        const m = new Map(state.userOverrides);
        m.delete(action.toolId);
        next.userOverrides = m;
      }
      return next;
    }

    case 'USER_CLICKED': {
      // Pure toggle: derive current expansion from reducer state and flip it.
      // This avoids closing over panelState in the click handler (which would
      // re-create the callback on every panel state change).
      // Note: we can't check hasResult here, but that's fine — once a result
      // arrives the tool is already visually compact, so clicking it correctly
      // expands either way.
      const override = state.userOverrides.get(action.toolId);
      const autoExpanded = state.autoExpandedIds.has(action.toolId);
      const currentlyExpanded = override !== undefined ? override : autoExpanded;
      const m = new Map(state.userOverrides);
      m.set(action.toolId, !currentlyExpanded);
      return { ...state, userOverrides: m };
    }

    default:
      return state;
  }
}

// ============================================================================
// Expansion Logic
// ============================================================================

/**
 * Determine if a tool should be expanded in the panel.
 *
 * Priority:
 * 1. User override → return that value (user always wins)
 * 2. Auto-expanded → true only if tool has no result yet (still streaming)
 * 3. Otherwise → collapsed
 */
export function isToolExpanded(
  toolId: string,
  state: PanelState,
  hasResult?: boolean,
): boolean {
  // User override always wins
  const override = state.userOverrides.get(toolId);
  if (override !== undefined) return override;
  // Auto-expanded → only if still streaming (no result yet)
  if (state.autoExpandedIds.has(toolId) && !hasResult) return true;
  // Default: collapsed
  return false;
}
