/**
 * Settings Popup — gear icon with popup panel
 *
 * Gear icon rotates 45deg when pinned. Pop animation on initial pin.
 * Popup contains render mode select. Click-outside closes popup.
 * Different hover wobble keyframes for pinned vs unpinned states.
 *
 * @module control-panel/SettingsPopup
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { SettingsIcon } from './icons.js';
import type { RenderMode } from '../../types.js';

interface SettingsPopupProps {
  pinned: boolean;
  onToggle: () => void;
  renderMode: RenderMode;
  onRenderModeChange: (mode: RenderMode) => void;
}

const RENDER_MODES: { value: RenderMode; label: string }[] = [
  { value: 'rich', label: 'Rich' },
  { value: 'yaml', label: 'YAML' },
  { value: 'compact', label: 'Compact' },
];

export function SettingsPopup({ pinned, onToggle, renderMode, onRenderModeChange }: SettingsPopupProps): React.JSX.Element {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [justPinned, setJustPinned] = useState(false);
  const [hoverClass, setHoverClass] = useState('');

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
    'crispy-cp-settings',
    pinned ? 'crispy-cp-settings--pinned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const btnClass = [
    'crispy-cp-settings__btn',
    hoverClass,
    justPinned ? 'animate-in' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      ref={containerRef}
      className={containerClass}
      onMouseEnter={() => setHoverClass('hovering')}
      onMouseLeave={() => setHoverClass('hover-out')}
    >
      <button
        className={btnClass}
        title="Display settings"
        onClick={handleClick}
        onAnimationEnd={() => setJustPinned(false)}
      >
        <SettingsIcon />
      </button>
      {pinned && (
        <div className="crispy-cp-settings__popup">
          <div className="crispy-cp-settings__popup-header">Display Settings</div>
          <label className="crispy-cp-settings__row">
            <span>Render Mode</span>
            <select
              value={renderMode}
              onChange={(e) => onRenderModeChange(e.target.value as RenderMode)}
            >
              {RENDER_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </span>
  );
}
