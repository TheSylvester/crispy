/**
 * Tool Badge — colored pill showing tool name (text only, no icon)
 *
 * The icon is rendered beside the badge inside the tool card summary row.
 * Automatically picks white or dark text based on background luminance
 * when textColor is not explicitly provided.
 *
 * @module webview/renderers/tools/shared/ToolBadge
 */

interface ToolBadgeProps {
  color: string;
  textColor?: string;
  label: string;
}

/**
 * Pick white or dark text based on the background hex color's relative luminance.
 * Falls back to #fff for non-hex inputs (gradients, var(), etc.).
 */
function contrastText(bg: string): string {
  const match = bg.match(/^#([0-9a-f]{3,8})$/i);
  if (!match) return '#fff';

  let hex = match[1];
  // Expand shorthand (#abc → #aabbcc)
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length < 6) return '#fff';

  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  // sRGB relative luminance (simplified)
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? '#1e1e1e' : '#fff';
}

export function ToolBadge({ color, textColor, label }: ToolBadgeProps): React.JSX.Element {
  const resolvedText = textColor ?? contrastText(color);
  return (
    <span className="crispy-tool-badge" style={{ background: color, color: resolvedText }}>
      {label}
    </span>
  );
}
