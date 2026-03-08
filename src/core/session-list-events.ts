/**
 * Session List Events — Push-based session list updates
 *
 * Events pushed on a global channel (not per-session) to notify
 * connected frontends of session list changes.
 *
 * Separate discriminated union from SubscriberEvent — these are global,
 * not per-session.
 *
 * @module session-list-events
 */

import type { SessionInfo } from './agent-adapter.js';
import type { SessionChannelState } from './session-channel.js';

/** Events pushed on the global session-list channel. */
export type SessionListEvent =
  | { type: 'session_list_upsert'; session: SessionInfo }
  | { type: 'session_list_remove'; sessionId: string }
  | { type: 'session_status_changed'; sessionId: string; status: SessionChannelState };

/** Sentinel sessionId used to route session-list events on the shared event channel. */
export const SESSION_LIST_CHANNEL_ID = '__session_list__';
