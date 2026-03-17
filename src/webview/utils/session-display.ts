/**
 * Session Display Name — single source of truth for session labels
 *
 * Priority: title (session_titles table) > label (first user message)
 * > truncated session ID.
 *
 * @module session-display
 */

import type { WireSessionInfo } from '../transport.js';

export function getSessionDisplayName(
  session: Pick<WireSessionInfo, 'title' | 'label' | 'sessionId'>,
): string {
  return session.title?.trim() || session.label?.trim()
    || session.sessionId.slice(0, 8) + '\u2026';
}

/**
 * Middle-truncate a string: first `headLen` chars + ' \u2026 ' + last `tailLen` chars.
 * Returns the original string if it fits within headLen + tailLen + 5 (separator overhead).
 */
export function middleTruncate(text: string, headLen = 50, tailLen = 30): string {
  const threshold = headLen + tailLen + 5;
  if (text.length <= threshold) return text;
  return text.slice(0, headLen) + ' \u2026 ' + text.slice(-tailLen);
}
