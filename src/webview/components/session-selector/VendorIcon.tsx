/**
 * VendorIcon — vendor icon registry component
 *
 * Maps vendor slugs to inline SVG icons. Supports the three native vendors
 * (Claude, Codex, Gemini) with specific brand marks, and falls back to a
 * text badge for unknown/dynamic vendors.
 *
 * ALL vendors get an icon — there is no "default vendor gets no icon" rule.
 * Icons render at 12x12px by default with ~85% opacity (via CSS).
 *
 * Does NOT handle click behavior or selection state — that's the parent's job.
 *
 * @module VendorIcon
 */

interface VendorIconProps {
  vendor: string;
  size?: number;
  className?: string;
}

function ClaudeIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16.98 11.39L12 1.45l-1.93 3.89 3.06 6.15 3.85-.1zM14.13 13.32l-3.88.1L12 17.38l2.13-4.06zM9.87 5.75L5.02 15.5l3.85.1 3.06-6.15-2.06-3.7zM7.73 17.22L4 23.55h4.98l1.81-3.43-3.06-2.9zM12 18.61l-1.81 3.43L12 23.55l1.81-1.51L12 18.61zM16.27 17.22l-3.06 2.9 1.81 3.43H20l-3.73-6.33z"
        fill="#D97757"
      />
    </svg>
  );
}

function CodexIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.18L18.5 7.5 12 10.82 5.5 7.5 12 4.18zM5 9.06l6 3.32v6.56l-6-3.32V9.06zm8 9.88v-6.56l6-3.32v6.56l-6 3.32z"
        fill="currentColor"
      />
    </svg>
  );
}

function GeminiIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gemini-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4285F4" />
          <stop offset="50%" stopColor="#9B72CB" />
          <stop offset="100%" stopColor="#D96570" />
        </linearGradient>
      </defs>
      <path
        d="M12 2C12 2 14.5 9.5 22 12c-7.5 2.5-10 10-10 10S9.5 14.5 2 12c7.5-2.5 10-10 10-10z"
        fill="url(#gemini-grad)"
      />
    </svg>
  );
}

export function VendorIcon({ vendor, size = 12, className }: VendorIconProps): React.JSX.Element {
  const baseClass = className ?? 'crispy-vendor-icon';

  switch (vendor) {
    case 'claude':
      return (
        <span className={baseClass} data-vendor="claude" title="Claude">
          <ClaudeIcon size={size} />
        </span>
      );
    case 'codex':
      return (
        <span className={baseClass} data-vendor="codex" title="Codex">
          <CodexIcon size={size} />
        </span>
      );
    case 'gemini':
      return (
        <span className={baseClass} data-vendor="gemini" title="Gemini">
          <GeminiIcon size={size} />
        </span>
      );
    default:
      return (
        <span className="crispy-vendor-badge" data-vendor={vendor} title={vendor}>
          {vendor}
        </span>
      );
  }
}
