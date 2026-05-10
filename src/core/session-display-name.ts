/**
 * Session Display Name — shared cascade for session-list UIs.
 *
 * The single canonical resolver for "what string represents this session
 * to the user?" Used by webview, host (projects RPC), Discord, and
 * session-manager so the display order never drifts between surfaces.
 *
 * Cascade (5-tier):
 *   customTitle  — user `/rename` (or vendor-native rename)
 *   aiTitle      — SDK auto-generated
 *   lastUserPrompt — first user message preview
 *   label        — vendor-extracted shorthand
 *   sessionId    — fallback: first 8 chars + ellipsis
 *
 * @module session-display-name
 */

/**
 * Resolve a session's display name from its metadata fields, applying
 * the canonical 5-tier cascade above. Always returns a non-empty string.
 */
export function getSessionDisplayName(info: {
  customTitle?: string;
  aiTitle?: string;
  lastUserPrompt?: string;
  label?: string;
  sessionId: string;
}): string {
  return (
    info.customTitle?.trim() ||
    info.aiTitle?.trim() ||
    info.lastUserPrompt?.trim() ||
    info.label?.trim() ||
    info.sessionId.slice(0, 8) + '…'
  );
}
