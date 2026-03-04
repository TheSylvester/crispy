/**
 * Session Display Name — single source of truth for session labels
 *
 * Priority: title (short Rosie label) > quest (full goal) > label (first
 * user message) > truncated session ID.
 *
 * @module session-display
 */

import type { WireSessionInfo } from '../transport.js';

export function getSessionDisplayName(
  session: Pick<WireSessionInfo, 'title' | 'quest' | 'label' | 'sessionId'>,
): string {
  return session.title || session.quest || session.label
    || session.sessionId.slice(0, 8) + '\u2026';
}
