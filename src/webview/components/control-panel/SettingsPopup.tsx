/**
 * Settings Popup — gear icon with popup panel
 *
 * Gear icon rotates 45deg when pinned. Pop animation on initial pin.
 * Popup contains render mode select. Click-outside closes popup.
 * Hover wobble animations are pure CSS — no React state needed.
 *
 * @module control-panel/SettingsPopup
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { SettingsIcon } from './icons.js';
import type { RenderMode } from '../../types.js';
import type { ToolViewOverride } from '../../context/PreferencesContext.js';

interface SettingsPopupProps {
  pinned: boolean;
  onToggle: () => void;
  renderMode: RenderMode;
  onRenderModeChange: (mode: RenderMode) => void;
  toolViewOverride?: ToolViewOverride;
  onToolViewOverrideChange?: (override: ToolViewOverride) => void;
}

const RENDER_MODES: { value: RenderMode; label: string }[] = [
  { value: 'rich', label: 'Rich' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'yaml', label: 'YAML' },
  { value: 'compact', label: 'Compact' },
];

const TOOL_VIEW_MODES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'collapsed', label: 'Collapsed' },
  { value: 'compact', label: 'Compact' },
  { value: 'expanded', label: 'Expanded' },
];

/** Check once whether debug mode is enabled */
const isDebugMode = window.location.search.includes('debug=1');

export function SettingsPopup({ pinned, onToggle, renderMode, onRenderModeChange, toolViewOverride, onToolViewOverrideChange }: SettingsPopupProps): React.JSX.Element {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [justPinned, setJustPinned] = useState(false);

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
          {isDebugMode && onToolViewOverrideChange && (
            <label className="crispy-cp-settings__row">
              <span>Tool View</span>
              <select
                value={toolViewOverride ?? 'auto'}
                onChange={(e) => {
                  const val = e.target.value;
                  onToolViewOverrideChange(val === 'auto' ? null : val as ToolViewOverride);
                }}
              >
                {TOOL_VIEW_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </span>
  );
}
