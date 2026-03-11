/**
 * Control Panel Icons
 *
 * Inline JSX SVG icons for the control panel. Each icon accepts className
 * and onAnimationEnd props to support CSS animation integration.
 *
 * Inline SVG icons for the control panel toggles and actions.
 *
 * @module control-panel/icons
 */

interface IconProps {
  className?: string;
  onAnimationEnd?: () => void;
}

/** Shield icon — safe/unchecked state. Muted outline with translucent fill. */
export function ShieldSafeIcon({ className, ...props }: IconProps): React.JSX.Element {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M8 1L2 3v4c0 3.6 2.4 6.9 6 8 3.6-1.1 6-4.4 6-8V3L8 1zm0 1.2l5 1.7v4.1c0 3-2 5.6-5 6.5-3-.9-5-3.5-5-6.5V3.9l5-1.7z" />
      <path d="M8 4.5L4.5 6v2.5c0 2.1 1.4 4 3.5 4.7 2.1-.7 3.5-2.6 3.5-4.7V6L8 4.5z" opacity={0.3} />
    </svg>
  );
}

/** Shield icon — danger/checked state. Outline with lightning bolt. */
export function ShieldDangerIcon({ className, ...props }: IconProps): React.JSX.Element {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M8 1L2 3v4c0 3.6 2.4 6.9 6 8 3.6-1.1 6-4.4 6-8V3L8 1zm0 1.2l5 1.7v4.1c0 3-2 5.6-5 6.5-3-.9-5-3.5-5-6.5V3.9l5-1.7z" />
      <path d="M9 3.5L7 7h2l-1.5 5.5L10 8H8l1-4.5z" />
    </svg>
  );
}

/** Chrome icon — monochrome/unchecked state. Single-color logo. */
export function ChromeMonoIcon({ className, ...props }: IconProps): React.JSX.Element {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z" />
    </svg>
  );
}

/** Chrome icon — full-color/checked state. Multi-fill Google Chrome logo. */
export function ChromeColorIcon({ className, ...props }: IconProps): React.JSX.Element {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" {...props}>
      <path fill="#EA4335" d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0z" />
      <path fill="#34A853" d="M1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29z" />
      <path fill="#FBBC04" d="M15.273 7.636a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364z" />
      <circle fill="#4285F4" cx="12" cy="12" r="4.364" />
    </svg>
  );
}

/** Settings gear icon. */
export function SettingsIcon({ className, ...props }: IconProps): React.JSX.Element {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.4v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 13.9l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2.1 4l2-2 2.1 1.4.4-2.4h2.8zm.6 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm1 0a3 3 0 1 0-6 0 3 3 0 0 0 6 0z" />
    </svg>
  );
}

/** Robot head icon — Rosie observability panel. */
export function RobotIcon({ className, ...props }: IconProps): React.JSX.Element {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" {...props}>
      {/* Antenna */}
      <line x1="8" y1="1" x2="8" y2="3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="1" r="1" />
      {/* Head */}
      <rect x="3" y="3" width="10" height="9" rx="2" />
      {/* Eyes */}
      <circle cx="6" cy="7.5" r="1.2" fill="var(--bg-editor, #1e1e1e)" />
      <circle cx="10" cy="7.5" r="1.2" fill="var(--bg-editor, #1e1e1e)" />
      {/* Mouth */}
      <rect x="5.5" y="10" width="5" height="0.8" rx="0.4" fill="var(--bg-editor, #1e1e1e)" />
      {/* Ears */}
      <rect x="1" y="5.5" width="1.5" height="3" rx="0.5" />
      <rect x="13.5" y="5.5" width="1.5" height="3" rx="0.5" />
    </svg>
  );
}

/** Rewind (↺) icon — Unicode glyph. */
export function RewindIcon({ className, ...props }: IconProps): React.JSX.Element {
  return <span className={className} {...props}>↺</span>;
}

/** Fork (⑂) icon — Unicode glyph. */
export function ForkIcon({ className, ...props }: IconProps): React.JSX.Element {
  return <span className={className} {...props}>⑂</span>;
}

/** Clipboard icon — copy to clipboard action. */
export function CopyIcon({ className, ...props }: IconProps): React.JSX.Element {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M4 4v-2a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2v2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h1zm1 0h4a1 1 0 0 1 1 1v5h2V2H5v2zm-2 2v7h6V6H3z" />
    </svg>
  );
}

/** Checkmark icon — success/copied feedback. */
export function CheckIcon({ className, ...props }: IconProps): React.JSX.Element {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
    </svg>
  );
}

/** Microphone icon — voice input. */
export function MicIcon({ className, ...props }: IconProps): React.JSX.Element {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M8 1a2 2 0 0 0-2 2v4a2 2 0 1 0 4 0V3a2 2 0 0 0-2-2z" />
      <path d="M3.5 6.5a.5.5 0 0 1 1 0V7a3.5 3.5 0 1 0 7 0v-.5a.5.5 0 0 1 1 0V7a4.5 4.5 0 0 1-4 4.473V13.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-2.027A4.5 4.5 0 0 1 3.5 7V6.5z" />
    </svg>
  );
}
