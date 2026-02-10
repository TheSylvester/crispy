/**
 * Control Panel Types
 *
 * Shared type definitions for the control panel component tree.
 * Matches Leto's webview-next type definitions exactly.
 *
 * @module control-panel/types
 */

/** Agency mode determines how Claude handles edits and permissions. */
export type AgencyMode =
  | 'plan-mode'
  | 'edit-automatically'
  | 'ask-before-edits'
  | 'bypass-permissions';

/** Model selection for Claude. Empty string means "Default". */
export type ModelOption = '' | 'sonnet' | 'opus' | 'haiku';

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
  chromeEnabled: boolean;
  isRunning: boolean;
  input: string;
  attachedImages: AttachedImage[];
  pastedImageCounter: number;
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
  | { type: 'SET_FILE_CONTEXT'; enabled: boolean };

/** Default initial state for the control panel. */
export const DEFAULT_CONTROL_PANEL_STATE: ControlPanelState = {
  bypassEnabled: false,
  agencyMode: 'ask-before-edits',
  model: '',
  fileContextEnabled: false,
  fileContextLabel: 'No file open',
  contextPercent: 42,
  chromeEnabled: false,
  isRunning: false,
  input: '',
  attachedImages: [],
  pastedImageCounter: 0,
};

/** Agency mode display labels for the dropdown. */
export const AGENCY_MODE_LABELS: Record<AgencyMode, string> = {
  'plan-mode': '|| plan mode on',
  'edit-automatically': '>> accept edits on',
  'ask-before-edits': '? ask before edits',
  'bypass-permissions': '>> bypass permissions on',
};

/** Agency mode colors — matches CSS --frame-highlight values. */
export const AGENCY_MODE_COLORS: Record<AgencyMode, string> = {
  'ask-before-edits': '#FFFFFF',
  'edit-automatically': '#40A8E8',
  'plan-mode': '#47988c',
  'bypass-permissions': '#E84040',
};
