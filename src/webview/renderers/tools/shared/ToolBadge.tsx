/**
 * Tool Badge — frosted glass mono tool name pill
 *
 * Renders the tool name in colored monospace text over a frosted
 * glass background with subtle border. Used in dot-lines and
 * expanded card headers.
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
  const bg = hexToRgba(color, 0.10);
  const border = hexToRgba(color, 0.25);
  return (
    <span
      className="crispy-tool-badge"
      style={{
        color: textColor ?? color,
        background: bg ?? 'var(--tint-soft)',
        border: `1px solid ${border ?? 'var(--glass-border)'}`,
        boxShadow: `inset 0 0 8px ${hexToRgba(color, 0.04) ?? 'transparent'}`,
      }}
    >
      {label.toLowerCase()}
    </span>
  );
}
