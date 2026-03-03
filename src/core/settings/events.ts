/**
 * Settings Events — Push-based settings change notifications
 *
 * Events pushed on a global channel (not per-session) to notify
 * connected frontends of settings changes.
 *
 * Replaces PROVIDERS_CHANNEL_ID from provider-events.ts.
 *
 * @module settings/events
 */

import type { SettingsSection, WireSettingsSnapshot } from './types.js';

/** Sentinel sessionId used to route settings events on the shared event channel. */
export const SETTINGS_CHANNEL_ID = '__settings__';

/** Global event pushed when settings change. */
export interface SettingsChangedGlobalEvent {
  type: 'settings_snapshot';
  snapshot: WireSettingsSnapshot;
  changedSections: SettingsSection[];
}
