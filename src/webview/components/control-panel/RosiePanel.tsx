/**
 * Rosie Log Panel — unified structured log stream
 *
 * Robot icon with wobble hover animation. Pop animation on initial pin.
 * Popup displays a scrollable list of log entries (summarize results,
 * debug info, warnings). Entries with data expand to show YAML on click.
 * Click-outside closes popup.
 *
 * @module control-panel/RosiePanel
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { RobotIcon } from './icons.js';
import { YamlDump } from '../../renderers/YamlDump.js';
import type { RosieLogEntry } from '../../../core/rosie/debug-log.js';

interface RosiePanelProps {
  pinned: boolean;
  onToggle: () => void;
  entries: RosieLogEntry[];
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function RosieLogEntryRow({ entry }: { entry: RosieLogEntry }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasData = entry.data != null;

  return (
    <div
      className={`crispy-cp-rosie__entry${hasData ? ' crispy-cp-rosie__entry--clickable' : ''}`}
      onClick={hasData ? () => setExpanded(!expanded) : undefined}
    >
      <div className="crispy-cp-rosie__entry-header">
        <span className="crispy-cp-rosie__entry-time">{formatTime(entry.ts)}</span>
        <span className="crispy-cp-rosie__entry-source">{entry.source}</span>
        {entry.level !== 'info' && (
          <span className={`crispy-cp-rosie__entry-level crispy-cp-rosie__entry-level--${entry.level}`}>
            {entry.level}
          </span>
        )}
        <span className="crispy-cp-rosie__entry-summary">{entry.summary}</span>
        {hasData && (
          <span className={`crispy-cp-rosie__entry-chevron${expanded ? ' crispy-cp-rosie__entry-chevron--open' : ''}`}>
            &#9656;
          </span>
        )}
      </div>
      {expanded && hasData && (
        <pre className="crispy-cp-rosie__entry-data"><YamlDump value={entry.data} /></pre>
      )}
    </div>
  );
}

export function RosiePanel({ pinned, onToggle, entries }: RosiePanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [justPinned, setJustPinned] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  // Recenter popup within viewport
  useEffect(() => {
    if (!pinned || !containerRef.current || !popupRef.current) return;
    const btnRect = containerRef.current.getBoundingClientRect();
    const popupWidth = popupRef.current.offsetWidth;
    const vw = window.innerWidth;
    const idealLeft = btnRect.left + btnRect.width / 2 - popupWidth / 2;

    let offset = 0;
    if (idealLeft < 8) {
      offset = 8 - idealLeft;
    } else if (idealLeft + popupWidth > vw - 8) {
      offset = vw - 8 - (idealLeft + popupWidth);
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
        title="Rosie log stream"
        onClick={handleClick}
        onAnimationEnd={() => setJustPinned(false)}
      >
        <RobotIcon />
      </button>
      {pinned && (
        <div ref={popupRef} className="crispy-cp-rosie__popup" onClick={(e) => e.stopPropagation()}>
          <div className="crispy-cp-rosie__popup-header">Rosie Log</div>
          {entries.length > 0 ? (
            <div className="crispy-cp-rosie__log-list">
              {entries.map((entry) => (
                <RosieLogEntryRow key={entry.id} entry={entry} />
              ))}
            </div>
          ) : (
            <div className="crispy-cp-rosie__empty">
              No log entries yet.
            </div>
          )}
        </div>
      )}
    </span>
  );
}
