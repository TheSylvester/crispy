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

