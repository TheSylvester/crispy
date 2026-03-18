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
  // Claude (full model strings + short aliases used by UI/adapter)
  'claude:claude-haiku-4-5':  200_000,
  'claude:claude-sonnet-4-5': 200_000,
  'claude:claude-sonnet-4-6': 200_000,
  'claude:claude-opus-4-6':   1_000_000,
  'claude:haiku':              200_000,
  'claude:sonnet':             200_000,
  'claude:opus':               1_000_000,
  'claude:':                   200_000,  // default Claude
  // Codex (OpenAI)
  'codex:gpt-5':               400_000,
  'codex:gpt-5-pro':           400_000,
  'codex:gpt-5-mini':          400_000,
  'codex:gpt-5-nano':          400_000,
  'codex:gpt-5-codex':         400_000,
  'codex:gpt-5.1':             400_000,
  'codex:gpt-5.1-codex':       400_000,
  'codex:gpt-5.1-codex-mini':  400_000,
  'codex:gpt-5.1-codex-max':   400_000,
  'codex:gpt-5.2':             400_000,
  'codex:gpt-5.2-pro':         400_000,
  'codex:gpt-5.2-codex':       400_000,
  'codex:gpt-5.3-instant':     200_000,
  'codex:gpt-5.4':           1_050_000,
  'codex:gpt-5.4-pro':       1_050_000,
  'codex:gpt-5.4-medium':      200_000,
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
 *
 * Handles both short aliases ("opus", "claude-opus-4-6") and date-suffixed
 * SDK model strings ("claude-opus-4-5-20251101") by trying an exact match
 * first, then stripping the date suffix for a prefix match.
 */
export function getContextWindowTokens(vendor: Vendor, model?: string): number {
  const key = `${vendor}:${model || ''}`;
  if (CONTEXT_WINDOWS[key] !== undefined) return CONTEXT_WINDOWS[key];
  // Strip date suffix (e.g. "claude-opus-4-5-20251101" → "claude-opus-4-5")
  // SDK model strings append -YYYYMMDD or -YYYY-MM-DD; the table uses the
  // versionless form.
  if (model) {
    const stripped = model.replace(/(?:-\d{8}|-\d{4}-\d{2}-\d{2})$/, '');
    if (stripped !== model) {
      const strippedKey = `${vendor}:${stripped}`;
      if (CONTEXT_WINDOWS[strippedKey] !== undefined) return CONTEXT_WINDOWS[strippedKey];
    }
    // Family-name fallback: SDK model strings vary across versions
    // (claude-opus-4-6, claude-opus-4-5-20251101, claude-4-opus-20250514, etc.)
    // but the family name (opus/sonnet/haiku) determines the context window.
    const m = stripped.toLowerCase();
    if (m.includes('opus')) return CONTEXT_WINDOWS[`${vendor}:opus`] ?? MIN_CONTEXT_WINDOW;
    if (m.includes('sonnet')) return CONTEXT_WINDOWS[`${vendor}:sonnet`] ?? MIN_CONTEXT_WINDOW;
    if (m.includes('haiku')) return CONTEXT_WINDOWS[`${vendor}:haiku`] ?? MIN_CONTEXT_WINDOW;
  }
  // Try vendor default
  const vendorDefault = CONTEXT_WINDOWS[`${vendor}:`];
  if (vendorDefault !== undefined) return vendorDefault;
  return MIN_CONTEXT_WINDOW;
}
