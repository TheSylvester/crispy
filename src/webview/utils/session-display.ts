/**
 * Session Display — name and subtitle for session list items
 *
 * Title chain: customTitle (user /rename) > title (Rosie-generated) > aiTitle
 * (SDK auto-generated) > lastUserPrompt > label (first user prompt) > truncated
 * session ID. User intent (explicit rename) wins; generic SDK fallback loses
 * to last prompt because it's less specific.
 *
 * Subtitle: picks the first candidate from [title, aiTitle, lastUser, label,
 * lastMsg] that is distinct from whatever won line 1, so the two lines never
 * show redundant content.
 *
 * @module session-display
 */

import type { WireSessionInfo } from '../transport.js';

export function getSessionDisplayName(
  session: Pick<
    WireSessionInfo,
    'customTitle' | 'aiTitle' | 'title' | 'label' | 'lastUserPrompt' | 'sessionId'
  >,
): string {
  return session.customTitle?.trim()
    || session.title?.trim()
    || session.aiTitle?.trim()
    || session.lastUserPrompt?.trim()
    || session.label?.trim()
    || session.sessionId.slice(0, 8) + '\u2026';
}

export function getSessionSubtitle(
  session: Pick<
    WireSessionInfo,
    'customTitle' | 'aiTitle' | 'title' | 'label' | 'lastUserPrompt' | 'lastMessage'
  >,
): string | null {
  const customTitle = session.customTitle?.trim();
  const title = session.title?.trim();
  const aiTitle = session.aiTitle?.trim();
  const lastUser = session.lastUserPrompt?.trim();
  const label = session.label?.trim();
  const lastMsg = session.lastMessage?.trim();

  const displayed =
    customTitle || title || aiTitle || lastUser || label;

  const candidates = [title, aiTitle, lastUser, label, lastMsg];

  for (const c of candidates) {
    if (c && c !== displayed) return c;
  }
  return null;
}
