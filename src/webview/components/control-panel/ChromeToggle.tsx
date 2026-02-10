/**
 * Chrome Toggle — icon toggle for Chrome browser integration
 *
 * Conditional rendering swaps between mono and color Chrome icons.
 * Pop animation on activation, wobble on hover.
 *
 * @module control-panel/ChromeToggle
 */

import { useState, useId } from 'react';
import { ChromeMonoIcon, ChromeColorIcon } from './icons.js';

interface ChromeToggleProps {
  checked: boolean;
  onChange: (enabled: boolean) => void;
}

export function ChromeToggle({ checked, onChange }: ChromeToggleProps): React.JSX.Element {
  const inputId = useId();
  const [justActivated, setJustActivated] = useState(false);
  const [hoverClass, setHoverClass] = useState('');

  const handleChange = () => {
    const newVal = !checked;
    if (newVal) setJustActivated(true);
    onChange(newVal);
  };

  const containerClass = [
    'crispy-cp-chrome',
    checked ? 'crispy-cp-chrome--checked' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label
      className={containerClass}
      title="Enable Chrome browser integration"
      onMouseEnter={() => setHoverClass('hovering')}
      onMouseLeave={() => setHoverClass('hover-out')}
    >
      <input
        id={inputId}
        type="checkbox"
        className="crispy-cp-chrome__input"
        checked={checked}
        onChange={handleChange}
      />
      {checked ? (
        <ChromeColorIcon
          className={`crispy-cp-chrome__icon ${hoverClass} ${justActivated ? 'animate-in' : ''}`}
          onAnimationEnd={() => setJustActivated(false)}
        />
      ) : (
        <ChromeMonoIcon
          className={`crispy-cp-chrome__icon ${hoverClass}`}
        />
      )}
    </label>
  );
}
