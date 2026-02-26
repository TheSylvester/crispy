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
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
        fill="#D97757"
        fillRule="nonzero"
      />
    </svg>
  );
}

function CodexIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  );
}

function GeminiIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="gemini-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4285F4" />
          <stop offset="50%" stopColor="#9B72CB" />
          <stop offset="100%" stopColor="#D96570" />
        </linearGradient>
      </defs>
      <path
        d="M12 0C12 0 12 12 0 12c12 0 12 12 12 12s0-12 12-12C12 12 12 0 12 0z"
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
