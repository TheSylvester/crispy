/**
 * Panel Reducer — state management for the blocks tool panel
 *
 * Manages tool expansion state with:
 * - Sticky user pin (persists until tool leaves view)
 * - Active/streaming tools always expanded
 * - Recency-based auto-focus for latest arrived tool
 *
 * @module webview/blocks/panel-reducer
 */

import type { PanelAction, PanelState } from './types.js';

// ============================================================================
// Initial State
// ============================================================================

export const initialPanelState: PanelState = {
  userPinnedId: null,
  latestArrivedId: null,
  activeToolIds: new Set(),
};

// ============================================================================
// Reducer
// ============================================================================

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'TOOL_ARRIVED':
      return {
        ...state,
        latestArrivedId: action.toolId,
      };

    case 'TOOL_LEFT_VIEW': {
      const next = { ...state };
      // If the tool that left was pinned, unpin
      if (state.userPinnedId === action.toolId) next.userPinnedId = null;
      // If the tool that left was latest, clear
      if (state.latestArrivedId === action.toolId) next.latestArrivedId = null;
      // If the tool that left was active/streaming, remove it
      if (state.activeToolIds.has(action.toolId)) {
        const s = new Set(state.activeToolIds);
        s.delete(action.toolId);
        next.activeToolIds = s;
      }
      return next;
    }

    case 'USER_CLICKED':
      return {
        ...state,
        userPinnedId: action.toolId,
      };

    case 'STREAM_STARTED':
      return {
        ...state,
        activeToolIds: new Set([...state.activeToolIds, action.toolId]),
      };

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
 * 1. Active/streaming → always expanded
 * 2. User-pinned → expanded
 * 3. Latest arrived → expanded (auto-focus behavior)
 * 4. Everything else → collapsed
 */
export function isToolExpanded(
  toolId: string,
  state: PanelState,
  hasResult?: boolean,
): boolean {
  // Active/streaming → expanded, BUT NOT if tool already has a result
  if (state.activeToolIds.has(toolId) && !hasResult) return true;
  // User-pinned → expanded
  if (state.userPinnedId === toolId) return true;
  // Latest arrived → expanded (if nothing else claims expansion)
  if (state.latestArrivedId === toolId) return true;
  // Everything else → collapsed
  return false;
}

/**
 * Get the tool ID that should be "focused" in the panel.
 *
 * Priority:
 * 1. User-pinned tool
 * 2. Latest arrived tool
 * 3. First active/streaming tool
 * 4. null if nothing qualifies
 */
export function getFocusedToolId(state: PanelState): string | null {
  if (state.userPinnedId) return state.userPinnedId;
  if (state.latestArrivedId) return state.latestArrivedId;
  // First active tool
  const first = state.activeToolIds.values().next();
  if (!first.done) return first.value;
  return null;
}
