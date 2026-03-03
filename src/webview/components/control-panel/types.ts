/**
 * Control Panel Types
 *
 * Shared type definitions for the control panel component tree.
 *
 * @module control-panel/types
 */

import type { ContextUsage } from '../../../core/transcript.js';

/** Agency mode determines how Claude handles edits and permissions. */
export type AgencyMode =
  | 'plan-mode'
  | 'edit-automatically'
  | 'ask-before-edits'
  | 'bypass-permissions';

/**
 * Model selection. Empty string = Default (Claude Sonnet).
 * Format: "vendor:model" for explicit selections (e.g. "claude:opus").
 */
export type ModelOption = string;

export type { VendorModelGroup } from '../../../core/settings/provider-sync.js';

/** Re-export from core — one source of truth for the "vendor:model" parser. */
export { parseModelOption } from '../../../core/model-utils.js';

/** Represents an image attached to a message. */
export interface AttachedImage {
  /** Unique identifier for the attachment */
  id: string;
  /** Original file URI (empty for pasted images) */
  uri: string;
  /** Display name for the file */
  fileName: string;
  /** MIME type (e.g., 'image/png') */
  mimeType: string;
  /** Base64-encoded image data (without data: prefix) */
  data: string;
  /** Data URL for thumbnail display */
  thumbnailUrl: string;
}

/** State for the control panel component. */
export interface ControlPanelState {
  bypassEnabled: boolean;
  agencyMode: AgencyMode;
  model: ModelOption;
  fileContextEnabled: boolean;
  fileContextLabel: string;
  contextPercent: number;
  contextUsage: ContextUsage | null;
  chromeEnabled: boolean;
  isRunning: boolean;
  input: string;
  attachedImages: AttachedImage[];
  pastedImageCounter: number;
  forkMode: { fromSessionId: string; atMessageId?: string } | null;
}

/** Reducer action types for the control panel. */
export type Action =
  | { type: 'SET_BYPASS'; enabled: boolean }
  | { type: 'SET_AGENCY_MODE'; mode: AgencyMode }
  | { type: 'SET_MODEL'; model: ModelOption }
  | { type: 'SET_CHROME'; enabled: boolean }
  | { type: 'SET_INPUT'; value: string }
  | { type: 'CLEAR_INPUT' }
  | { type: 'ADD_IMAGE'; image: AttachedImage }
  | { type: 'REMOVE_IMAGE'; id: string }
  | { type: 'CLEAR_IMAGES' }
  | { type: 'INCREMENT_PASTE_COUNTER' }
  | { type: 'SET_FILE_CONTEXT'; enabled: boolean }
  | { type: 'SET_CONTEXT'; contextUsage: ContextUsage }
  | { type: 'RESET_CONTEXT' }
  | { type: 'SET_FORK_MODE'; forkMode: { fromSessionId: string; atMessageId?: string } | null };

/** Default initial state for the control panel. */
export const DEFAULT_CONTROL_PANEL_STATE: ControlPanelState = {
  bypassEnabled: false,
  agencyMode: 'ask-before-edits',
  model: '',
  fileContextEnabled: false,
  fileContextLabel: 'No file open',
  contextPercent: 0,
  contextUsage: null,
  chromeEnabled: false,
  isRunning: false,
  input: '',
  attachedImages: [],
  pastedImageCounter: 0,
  forkMode: null,
};

/** Agency mode display labels for the dropdown. */
export const AGENCY_MODE_LABELS: Record<AgencyMode, string> = {
  'plan-mode': '|| plan mode on',
  'edit-automatically': '>> accept edits on',
  'ask-before-edits': '? ask before edits',
  'bypass-permissions': '>> bypass permissions on',
};

/** Short agency mode labels for compact/narrow layouts. */
export const AGENCY_MODE_LABELS_SHORT: Record<AgencyMode, string> = {
  'plan-mode': '|| plan',
  'edit-automatically': '>> accept',
  'ask-before-edits': '? ask',
  'bypass-permissions': '>> bypass',
};

/** Agency mode colors — matches CSS --frame-highlight values. */
export const AGENCY_MODE_COLORS: Record<AgencyMode, string> = {
  'ask-before-edits': '#FFFFFF',
  'edit-automatically': '#40A8E8',
  'plan-mode': '#47988c',
  'bypass-permissions': '#E84040',
};

/** Map local agency mode to the transport's permission mode string. */
export function mapAgencyToPermissionMode(
  agencyMode: AgencyMode,
): 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' {
  const mapping: Record<AgencyMode, 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'> = {
    'plan-mode': 'plan',
    'edit-automatically': 'acceptEdits',
    'ask-before-edits': 'default',
    'bypass-permissions': 'bypassPermissions',
  };
  return mapping[agencyMode];
}

/** Map a transport permission mode string back to the local agency mode. */
export function mapPermissionModeToAgency(
  mode: string,
): AgencyMode | null {
  const mapping: Record<string, AgencyMode> = {
    plan: 'plan-mode',
    acceptEdits: 'edit-automatically',
    default: 'ask-before-edits',
    bypassPermissions: 'bypass-permissions',
  };
  return mapping[mode] ?? null;
}
