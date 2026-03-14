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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M13.798 23.976a5.7 5.7 0 0 1-2.26-.456 6.1 6.1 0 0 1-1.903-1.27 5.7 5.7 0 0 1-1.88.311 5.75 5.75 0 0 1-2.95-.79 6.2 6.2 0 0 1-2.188-2.159q-.81-1.366-.809-3.045 0-.695.19-1.51a6.4 6.4 0 0 1-1.475-2.038A5.95 5.95 0 0 1 0 10.573Q0 9.278.547 8.08q.547-1.2 1.523-2.062a5.5 5.5 0 0 1 2.307-1.223A5.7 5.7 0 0 1 5.472 2.35 6.1 6.1 0 0 1 7.565.623 5.8 5.8 0 0 1 10.206 0q1.19 0 2.26.456a6.1 6.1 0 0 1 1.903 1.27 5.7 5.7 0 0 1 1.88-.311q1.594 0 2.95.79a6 6 0 0 1 2.165 2.159q.832 1.366.832 3.045 0 .695-.19 1.51a6.3 6.3 0 0 1 1.475 2.062q.523 1.15.523 2.422a5.9 5.9 0 0 1-.547 2.493q-.547 1.2-1.546 2.086a5.4 5.4 0 0 1-2.284 1.199 5.56 5.56 0 0 1-1.118 2.445 5.9 5.9 0 0 1-2.07 1.727 5.8 5.8 0 0 1-2.64.623m-5.876-2.997q1.19 0 2.07-.504l4.472-2.589a.53.53 0 0 0 .238-.455v-2.062L8.945 18.7a.96.96 0 0 1-1.047 0l-4.496-2.613a.7.7 0 0 1-.024.168v.287q0 1.224.571 2.254a4.24 4.24 0 0 0 1.642 1.583q1.047.6 2.331.599m.238-3.908a.6.6 0 0 0 .262.072q.118 0 .238-.072l1.784-1.031-5.734-3.357q-.522-.312-.523-.935V6.545a4.3 4.3 0 0 0-1.903 1.63 4.25 4.25 0 0 0-.714 2.398q0 1.176.595 2.254.594 1.08 1.546 1.63zm5.638 5.323q1.26 0 2.284-.576a4.3 4.3 0 0 0 1.618-1.582q.595-1.008.595-2.254v-5.179a.47.47 0 0 0-.238-.431l-1.808-1.055v6.689q0 .624-.524.935l-4.496 2.613a4.3 4.3 0 0 0 2.57.84m.904-8.776v-3.26l-2.688-1.535-2.712 1.535v3.26l2.712 1.535zM7.756 5.97q0-.623.523-.935l4.496-2.613a4.3 4.3 0 0 0-2.569-.84q-1.26 0-2.284.576A4.3 4.3 0 0 0 6.304 3.74q-.57 1.008-.57 2.254v5.155q0 .287.237.455l1.785 1.055zM19.84 17.43a4.16 4.16 0 0 0 1.88-1.63 4.33 4.33 0 0 0 .713-2.397q0-1.176-.595-2.254-.594-1.08-1.546-1.63l-4.449-2.59q-.143-.096-.261-.072a.46.46 0 0 0-.238.072L13.56 7.936l5.758 3.38a.9.9 0 0 1 .38.384q.143.216.143.528zM15.059 5.25q.524-.335 1.047 0l4.52 2.662V7.48q0-1.15-.57-2.181A4.14 4.14 0 0 0 18.46 3.62q-1.023-.623-2.379-.623-1.19 0-2.07.503L9.54 6.09a.53.53 0 0 0-.238.455v2.062z"
        fill="currentColor"
      />
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

function OpenCodeIcon({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M3 7l6 5-6 5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 17h8"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
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
    case 'opencode':
      return (
        <span className={baseClass} data-vendor="opencode" title="OpenCode">
          <OpenCodeIcon size={size} />
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
