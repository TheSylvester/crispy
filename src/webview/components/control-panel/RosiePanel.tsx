/**
 * Rosie Observability Panel — robot icon with popup dashboard
 *
 * Robot icon with wobble hover animation. Pop animation on initial pin.
 * Popup displays Rosie bot analysis results (quest, title, summary, status, entities).
 * Click-outside closes popup.
 *
 * @module control-panel/RosiePanel
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { RobotIcon } from './icons.js';
import { CrispyMarkdown } from '../../renderers/CrispyMarkdown.js';

interface RosiePanelProps {
  pinned: boolean;
  onToggle: () => void;
  quest?: string;
  title?: string;
  summary?: string;
  status?: string;
  entities?: string;
}

export function RosiePanel({ pinned, onToggle, quest, title, summary, status, entities }: RosiePanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [justPinned, setJustPinned] = useState(false);

  const popupRef = useRef<HTMLDivElement>(null);
  const hasData = !!(quest || title || summary || status || entities);

  // Parse entities JSON array for rendering
  const entityList: string[] = (() => {
    if (!entities) return [];
    try {
      const parsed = JSON.parse(entities);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  // Recenter popup within viewport (same pattern as AttachmentsRow image preview)
  useEffect(() => {
    if (!pinned || !containerRef.current || !popupRef.current) return;
    const btnRect = containerRef.current.getBoundingClientRect();
    const popupWidth = popupRef.current.offsetWidth;
    const vw = window.innerWidth;
    // Where the popup's left edge would be if perfectly centered on the button
    const idealLeft = btnRect.left + btnRect.width / 2 - popupWidth / 2;

    let offset = 0;
    if (idealLeft < 8) {
      offset = 8 - idealLeft; // nudge right
    } else if (idealLeft + popupWidth > vw - 8) {
      offset = vw - 8 - (idealLeft + popupWidth); // nudge left
    }
    containerRef.current.style.setProperty('--popup-offset', `${offset}px`);
  }, [pinned]);

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (pinned && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onToggle();
      }
    },
    [pinned, onToggle],
  );

  useEffect(() => {
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [handleClickOutside]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pinned) setJustPinned(true);
    onToggle();
  };

  const containerClass = [
    'crispy-cp-rosie',
    pinned ? 'crispy-cp-rosie--pinned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const btnClass = [
    'crispy-cp-rosie__btn',
    justPinned ? 'animate-in' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      ref={containerRef}
      className={containerClass}
    >
      <button
        className={btnClass}
        title="Rosie observability"
        onClick={handleClick}
        onAnimationEnd={() => setJustPinned(false)}
      >
        <RobotIcon />
      </button>
      {pinned && (
        <div ref={popupRef} className="crispy-cp-rosie__popup" onClick={(e) => e.stopPropagation()}>
          <div className="crispy-cp-rosie__popup-header">✨ Rosie: Summarize ✨</div>
          {hasData ? (
            <div className="crispy-cp-rosie__content">
              {title && <div className="crispy-cp-rosie__title">{title}</div>}
              {quest && <div className="crispy-cp-rosie__quest"><CrispyMarkdown>{quest}</CrispyMarkdown></div>}
              {summary && <div className="crispy-cp-rosie__summary"><CrispyMarkdown>{summary}</CrispyMarkdown></div>}
              {status && <div className="crispy-cp-rosie__status"><CrispyMarkdown>{status}</CrispyMarkdown></div>}
              {entityList.length > 0 && (
                <div className="crispy-cp-rosie__entities">
                  {entityList.map((e, i) => (
                    <span key={i} className="crispy-cp-rosie__entity-tag">{e}</span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="crispy-cp-rosie__empty">
              No Rosie outputs yet. Summarize analysis results will appear here after a turn completes.
            </div>
          )}
        </div>
      )}
    </span>
  );
}
