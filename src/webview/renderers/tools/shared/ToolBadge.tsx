/**
 * Tool Badge — colored mono tool name with tinted background
 *
 * Renders the tool name in colored monospace text over a subtle
 * tinted pill background. Used in expanded card headers.
 *
 * The icon is rendered beside the badge inside the tool card summary row.
 *
 * @module webview/renderers/tools/shared/ToolBadge
 */

interface ToolBadgeProps {
  color: string;
  textColor?: string;
  label: string;
}

/** Parse #rrggbb to rgba string at given alpha. Returns null for non-hex. */
function hexToRgba(hex: string, alpha: number): string | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function ToolBadge({ color, textColor, label }: ToolBadgeProps): React.JSX.Element {
  const bg = hexToRgba(color, 0.12);
  return (
    <span
      className="crispy-tool-badge"
      style={{
        color: textColor ?? color,
        background: bg ?? 'var(--tint-soft)',
      }}
    >
      {label.toLowerCase()}
    </span>
  );
}
