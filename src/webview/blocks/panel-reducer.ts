/**
 * Panel Reducer — state management for the blocks tool panel
 *
 * Simple two-field model:
 * - autoExpandedIds: system-suggested expansions (streaming tools)
 * - userOverrides: explicit user clicks (always wins over auto)
 *
 * Click behavior is exclusive selection — expanding a tool clears all
 * other expanded overrides so only one tool is user-pinned at a time.
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
      // Toggle with exclusive selection: expanding a tool clears all other
      // expanded overrides so only one tool is user-expanded at a time.
      // Collapsing just toggles the clicked tool off.
      const override = state.userOverrides.get(action.toolId);
      const autoExpanded = state.autoExpandedIds.has(action.toolId);
      const currentlyExpanded = override !== undefined ? override : autoExpanded;
      const expanding = !currentlyExpanded;
      const m = new Map<string, boolean>();
      if (expanding) {
        // Keep only false (user-collapsed) overrides; clear all true (expanded) ones
        for (const [id, val] of state.userOverrides) {
          if (!val) m.set(id, val);
        }
        m.set(action.toolId, true);
      } else {
        // Collapsing: copy existing overrides, toggle this one off
        for (const [id, val] of state.userOverrides) {
          m.set(id, val);
        }
        m.set(action.toolId, false);
      }
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
