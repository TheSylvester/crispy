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

/**
 * Known context window sizes in tokens, keyed by vendor default or model prefix.
 * Used for budget calculations (e.g. Rosie transcript assembly).
 * Conservative: when unknown, falls back to the smallest known window.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  // Claude
  'claude:claude-haiku-4-5':  200_000,
  'claude:claude-sonnet-4-5': 200_000,
  'claude:claude-sonnet-4-6': 200_000,
  'claude:claude-opus-4-6':   1_000_000,
  'claude:':                   200_000,  // default Claude
  // Codex (OpenAI)
  'codex:gpt-5.3-instant':    200_000,
  'codex:gpt-5.4-medium':     200_000,
  'codex:':                    200_000,  // default Codex
  // Gemini
  'gemini:':                   1_000_000,
  // OpenCode
  'opencode:':                 200_000,
};

/** Fallback when model is not in the lookup table. */
const MIN_CONTEXT_WINDOW = 200_000;

/**
 * Return the context window size (in tokens) for a given vendor + model.
 */
export function getContextWindowTokens(vendor: Vendor, model?: string): number {
  const key = `${vendor}:${model || ''}`;
  if (CONTEXT_WINDOWS[key] !== undefined) return CONTEXT_WINDOWS[key];
  // Try vendor default
  const vendorDefault = CONTEXT_WINDOWS[`${vendor}:`];
  if (vendorDefault !== undefined) return vendorDefault;
  return MIN_CONTEXT_WINDOW;
}
