/**
 * SessionItem — single session row in the session list
 *
 * Two-line layout: header row (label + meta cluster) and optional preview row.
 * The meta cluster contains the vendor icon, optional LIVE badge, and
 * relative timestamp. Search highlighting applies to both label and preview.
 *
 * Does NOT own selection logic — receives isSelected/isFocused/isLive as props
 * and calls onClick for selection.
 *
 * @module SessionItem
 */

import type { WireSessionInfo } from '../../transport.js';
import { VendorIcon } from './VendorIcon.js';
import { getSessionDisplayName } from '../../utils/session-display.js';
import { formatRelativeTime } from '../../utils/format.js';

interface SessionItemProps {
  session: WireSessionInfo;
  isSelected: boolean;
  isFocused: boolean;
  isLive: boolean;
  searchQuery: string;
  onClick: () => void;
  index: number;
}

/**
 * Highlight first case-insensitive match of `query` within `text`.
 * Returns JSX fragments with <mark> around the match — no dangerouslySetInnerHTML.
 */
function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;

  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;

  return (
    <>
      {text.slice(0, idx)}
      <mark className="crispy-session-highlight">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function SessionItem({
  session,
  isSelected,
  isFocused,
  isLive,
  searchQuery,
  onClick,
  index,
}: SessionItemProps): React.JSX.Element {
  const classNames = [
    'crispy-session-item',
    isSelected && 'crispy-session-item--selected',
    isFocused && 'crispy-session-item--focused',
  ].filter(Boolean).join(' ');

  const label = getSessionDisplayName(session);

  return (
    <li
      className={classNames}
      onClick={onClick}
      data-session-index={index}
      title={session.quest || label}
    >
      <div className="crispy-session-item__header">
        <span className="crispy-session-item__label">
          {highlightMatch(label, searchQuery)}
        </span>
        <div className="crispy-session-item__meta">
          <VendorIcon vendor={session.vendor} />
          {isLive && <span className="crispy-session-item__live">LIVE</span>}
          <span className="crispy-session-item__time">
            {formatRelativeTime(session.modifiedAt)}
          </span>
        </div>
      </div>
      {(session.botSummary || session.lastMessage) && (
        <div className="crispy-session-item__preview">
          {highlightMatch(session.botSummary || session.lastMessage!, searchQuery)}
        </div>
      )}
    </li>
  );
}
