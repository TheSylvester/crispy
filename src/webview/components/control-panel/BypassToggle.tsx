/**
 * Bypass Toggle — shield icon checkbox for bypass-permissions mode
 *
 * Renders a hidden checkbox with conditional shield icons (safe/danger).
 * Uses React conditional rendering for icon swapping (not CSS display toggling).
 * Danger icon has activate animation on check and persistent pulse when active.
 *
 * @module control-panel/BypassToggle
 */

import { useState, useId } from 'react';
import { ShieldSafeIcon, ShieldDangerIcon } from './icons.js';

interface BypassToggleProps {
  checked: boolean;
  onChange: (enabled: boolean) => void;
}

export function BypassToggle({ checked, onChange }: BypassToggleProps): React.JSX.Element {
  const inputId = useId();
  const [justActivated, setJustActivated] = useState(false);
  const [hoverClass, setHoverClass] = useState('');

  const handleChange = () => {
    const newVal = !checked;
    if (newVal) setJustActivated(true);
    onChange(newVal);
  };

  const containerClass = [
    'crispy-cp-bypass',
    checked ? 'crispy-cp-bypass--checked' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label
      className={containerClass}
      title="Enable --dangerously-skip-permissions mode (Alt+`)"
      data-shortcut="Alt+`"
      onMouseEnter={() => setHoverClass('hovering')}
      onMouseLeave={() => setHoverClass('hover-out')}
    >
      <input
        id={inputId}
        type="checkbox"
        className="crispy-cp-bypass__input"
        checked={checked}
        onChange={handleChange}
      />
      {checked ? (
        <ShieldDangerIcon
          className={`crispy-cp-bypass__icon ${hoverClass} ${justActivated ? 'animate-in' : ''}`}
          onAnimationEnd={() => setJustActivated(false)}
        />
      ) : (
        <ShieldSafeIcon
          className={`crispy-cp-bypass__icon ${hoverClass}`}
        />
      )}
    </label>
  );
}
