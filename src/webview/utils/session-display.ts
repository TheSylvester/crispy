/**
 * Session Display — name and subtitle for session list items
 *
 * Title chain: title (Rosie-generated) > lastUserPrompt > label (first user prompt)
 * > truncated session ID. Matches Claude Code's behavior where lastPrompt ranks
 * above firstPrompt.
 *
 * Subtitle: shows the *other* useful text that the title isn't already
 * displaying, falling back to lastMessage when no distinct prompt is available.
 * The two lines never show redundant content.
 *
 * @module session-display
 */

import type { WireSessionInfo } from '../transport.js';

export function getSessionDisplayName(
  session: Pick<WireSessionInfo, 'title' | 'label' | 'lastUserPrompt' | 'sessionId'>,
): string {
  return session.title?.trim()
    || session.lastUserPrompt?.trim()
    || session.label?.trim()
    || session.sessionId.slice(0, 8) + '\u2026';
}

export function getSessionSubtitle(
  session: Pick<WireSessionInfo, 'title' | 'label' | 'lastUserPrompt' | 'lastMessage'>,
): string | null {
  const title = session.title?.trim();
  const label = session.label?.trim();
  const lastUser = session.lastUserPrompt?.trim();
  const lastMsg = session.lastMessage?.trim();

  // Line 2 shows whichever prompt Line 1 isn't showing
  if (title) {
    // Rosie title on line 1 — show first prompt as context
    if (label && label !== title) return label;
    if (lastMsg && lastMsg !== title) return lastMsg;
    return null;
  }
  if (lastUser) {
    // Last prompt on line 1 — show first prompt if different
    if (label && label !== lastUser) return label;
    // Fall back to lastMessage (may be assistant text) for context
    if (lastMsg && lastMsg !== lastUser) return lastMsg;
    return null;
  }
  // First prompt (label) is on line 1 — fall back to lastMessage
  if (lastMsg && lastMsg !== label) return lastMsg;
  return null;
}
