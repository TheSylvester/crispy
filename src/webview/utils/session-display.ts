/**
 * Session Display — name and subtitle for session list items
 *
 * Title chain: title (Rosie-generated) > lastUserPrompt > label (first user prompt)
 * > truncated session ID. Matches Claude Code's behavior where lastPrompt ranks
 * above firstPrompt.
 *
 * Subtitle: always shows the *other* useful text that the title isn't already
 * displaying, so the two lines never show redundant content.
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
  session: Pick<WireSessionInfo, 'title' | 'label' | 'lastUserPrompt'>,
): string | null {
  const title = session.title?.trim();
  const label = session.label?.trim();
  const lastUser = session.lastUserPrompt?.trim();

  // Line 2 shows whichever prompt Line 1 isn't showing
  if (title) {
    // Rosie title on line 1 — show first prompt as context
    return label && label !== title ? label : null;
  }
  if (lastUser) {
    // Last prompt on line 1 — show first prompt if different
    return label && label !== lastUser ? label : null;
  }
  // First prompt (label) is on line 1 — nothing else to show
  return null;
}
