/**
 * Channel Event Types
 *
 * Vendor-agnostic event types for the channel event stream.
 * These flow alongside TranscriptEntry on the output side of a channel,
 * carrying status transitions and notifications that aren't conversation
 * content.
 *
 * Status events are sticky — the channel is "in" that state until the
 * next status event. Notification events are point-in-time.
 *
 * @module channel-events
 */

// ============================================================================
// Channel Status (sticky state transitions)
// ============================================================================

export type ChannelStatus = 'idle' | 'active' | 'awaiting_approval' | 'background';

export interface IdleEvent {
  type: 'status';
  status: 'idle';
  /** Authoritative turn completion signal — resolve immediately, no debounce. */
  turnComplete?: true;
}

export interface ActiveEvent {
  type: 'status';
  status: 'active';
}

export interface BackgroundEvent {
  type: 'status';
  status: 'background';
}

// ============================================================================
// Approval Types
// ============================================================================

/** A single option presented to the user in an approval prompt. */
export interface ApprovalOption {
  /** Machine-readable identifier (e.g. 'allow', 'deny', 'allow_session') */
  id: string;
  /** Human-readable label (e.g. "Allow once", "Always allow", "Deny") */
  label: string;
  /** Optional description for extra context */
  description?: string;
}

export interface AwaitingApprovalEvent {
  type: 'status';
  status: 'awaiting_approval';
  /** The tool_use block ID this approval is for */
  toolUseId: string;
  /** The tool being invoked */
  toolName: string;
  /** The tool's input arguments */
  input: unknown;
  /** Why the system is asking for approval */
  reason?: string;
  /** Structured choices the user can pick from */
  options: ApprovalOption[];
}

export type StatusEvent = IdleEvent | ActiveEvent | BackgroundEvent | AwaitingApprovalEvent;

// ============================================================================
// Channel Notifications (point-in-time events)
// ============================================================================

export interface ErrorEvent {
  type: 'notification';
  kind: 'error';
  error: Error | string;
}

export interface CompactingEvent {
  type: 'notification';
  kind: 'compacting';
}

export interface PermissionModeChangedEvent {
  type: 'notification';
  kind: 'permission_mode_changed';
  mode: string;
}

export interface SessionChangedEvent {
  type: 'notification';
  kind: 'session_changed';
  sessionId: string;
  previousSessionId?: string;
}

export interface SettingsChangedEvent {
  type: 'notification';
  kind: 'settings_changed';
  settings: import('./agent-adapter.js').AdapterSettings;
}

export interface RecallCatchupEvent {
  type: 'notification';
  kind: 'recall-catchup';
  status: import('./recall/catchup-types.js').CatchupStatus;
}

export type NotificationEvent =
  | ErrorEvent
  | CompactingEvent
  | PermissionModeChangedEvent
  | SessionChangedEvent
  | SettingsChangedEvent
  | RecallCatchupEvent;

// ============================================================================
// Channel Event (union)
// ============================================================================

export type ChannelEvent = StatusEvent | NotificationEvent;

// ============================================================================
// Channel Passthrough Types (for session-channel fan-out)
// ============================================================================

/** Stored approval data for replaying to late subscribers. */
export interface PendingApprovalInfo {
  toolUseId: string;
  toolName: string;
  input: unknown;
  reason?: string;
  options: ApprovalOption[];
}

/** Catchup message sent to late subscribers on subscribe(). */
export interface ChannelCatchupMessage {
  type: 'catchup';
  state: ChannelStatus | 'unattached' | 'streaming';
  sessionId: string | undefined;
  settings: import('./agent-adapter.js').AdapterSettings | null;
  contextUsage: import('./transcript.js').ContextUsage | null;
  pendingApprovals: PendingApprovalInfo[];
  /** Transcript entries loaded from history. Empty array for fresh sessions. */
  entries: import('./transcript.js').TranscriptEntry[];
}
