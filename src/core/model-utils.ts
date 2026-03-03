/**
 * Model Utilities
 *
 * Shared parsing for the "vendor:model" combined format used throughout the
 * application. This module lives in core so both core and webview can use it.
 *
 * @module model-utils
 */

import type { Vendor } from './transcript.js';

/**
 * Parse "vendor:model" → { vendor, model }.
 *
 * - Empty string → { vendor: 'claude', model: '' } (default)
 * - No colon → { vendor: 'claude', model: opt } (legacy compat)
 * - With colon → { vendor: <before colon>, model: <after colon> }
 */
export function parseModelOption(opt: string): { vendor: Vendor; model: string } {
  if (!opt) return { vendor: 'claude', model: '' };
  const idx = opt.indexOf(':');
  if (idx === -1) return { vendor: 'claude', model: opt }; // legacy compat
  return { vendor: opt.slice(0, idx) as Vendor, model: opt.slice(idx + 1) };
}
