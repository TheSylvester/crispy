/**
 * Copy Button — reusable clipboard copy with checkmark feedback
 *
 * Renders a small icon button that copies text to clipboard and shows
 * a checkmark for 1.5s on success. Uses e.stopPropagation() to prevent
 * parent click handlers (e.g., tool card panel activation) from firing.
 *
 * @module webview/components/CopyButton
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { CopyIcon, CheckIcon } from './control-panel/icons.js';
import { copyToClipboard } from '../utils/copy-markdown.js';

interface CopyButtonProps {
  /** Returns markdown to copy, or null to skip. */
  getText: () => string | null;
  /** Tooltip text (default: "Copy to clipboard"). */
  title?: string;
  /** Additional CSS class name. */
  className?: string;
  /** Use 20x20 sizing for tool card headers. */
  compact?: boolean;
}

export function CopyButton({
  getText,
  title = 'Copy to clipboard',
  className,
  compact,
}: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Stable ref for getText — avoids invalidating handleClick on every render
  const getTextRef = useRef(getText);
  getTextRef.current = getText;

  // Clean up timer on unmount
  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const text = getTextRef.current();
    if (text == null) return;

    void copyToClipboard(text).then((ok) => {
      if (ok) {
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      }
    });
  }, []);

  const classes = [
    'crispy-copy-btn',
    compact && 'crispy-copy-btn--compact',
    copied && 'crispy-copy-btn--copied',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      className={classes}
      title={copied ? 'Copied!' : title}
      onClick={handleClick}
      aria-label={title}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
