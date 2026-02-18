/**
 * Fork Button — text+icon button (original Leto webview style)
 *
 * Fixed 5em width, gray background. Fork SVG icon inside a span
 * for hover jiggle animation. Disabled state: opacity 0.4, not-allowed cursor.
 * Reports hover state via callback for fork preview glow on messages.
 *
 * @module control-panel/ForkButton
 */

import { ForkIcon } from './icons.js';

interface ForkButtonProps {
  disabled: boolean;
  onFork: () => void;
  onHoverChange: (hovering: boolean) => void;
}

export function ForkButton({ disabled, onFork, onHoverChange }: ForkButtonProps): React.JSX.Element {
  return (
    <button
      className="crispy-cp-fork"
      title="Fork conversation (Ctrl+Shift+Enter)"
      data-shortcut="Ctrl+Shift+Enter"
      disabled={disabled}
      onClick={onFork}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      Fork{' '}
      <span className="crispy-cp-fork__icon">
        <ForkIcon />
      </span>
    </button>
  );
}
