/**
 * Provider Events — Push-based provider config updates
 *
 * Events pushed on a global channel (not per-session) to notify
 * connected frontends of provider/model-group changes.
 *
 * Follows the session-list-events.ts pattern.
 *
 * @module provider-events
 */

import type { Vendor } from './transcript.js';

/** Model group for a vendor — used in the webview model dropdown. */
export interface VendorModelGroup {
  vendor: Vendor;
  label: string;
  models: { value: string; label: string }[];
}

/** Events pushed on the global providers channel. */
export type ProviderEvent =
  | { type: 'providers_changed'; groups: VendorModelGroup[] };

/** Sentinel sessionId used to route provider events on the shared event channel. */
export const PROVIDERS_CHANNEL_ID = '__providers__';
