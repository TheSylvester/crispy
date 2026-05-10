/**
 * Session Display — name and subtitle for session list items
 *
 * Display name uses the canonical 5-tier cascade from `core/session-display-name`:
 *   customTitle → aiTitle → lastUserPrompt → label → ID
 *
 * Subtitle: picks the first candidate from [aiTitle, lastUser, label, lastMsg]
 * that is distinct from whatever won line 1, so the two lines never show
 * redundant content.
 *
 * @module session-display
 */

import type { WireSessionInfo } from '../transport.js';
import { getSessionDisplayName as coreGetSessionDisplayName } from '../../core/session-display-name.js';

export function getSessionDisplayName(
  session: Pick<
    WireSessionInfo,
    'customTitle' | 'aiTitle' | 'label' | 'lastUserPrompt' | 'sessionId'
  >,
): string {
  return coreGetSessionDisplayName(session);
}

export function getSessionSubtitle(
  session: Pick<
    WireSessionInfo,
    'customTitle' | 'aiTitle' | 'label' | 'lastUserPrompt' | 'lastMessage'
  >,
): string | null {
  const customTitle = session.customTitle?.trim();
  const aiTitle = session.aiTitle?.trim();
  const lastUser = session.lastUserPrompt?.trim();
  const label = session.label?.trim();
  const lastMsg = session.lastMessage?.trim();

  const displayed = customTitle || aiTitle || lastUser || label;

  const candidates = [aiTitle, lastUser, label, lastMsg];

  for (const c of candidates) {
    if (c && c !== displayed) return c;
  }
  return null;
}
