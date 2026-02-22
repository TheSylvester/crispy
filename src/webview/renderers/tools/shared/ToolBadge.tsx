/**
 * Tool Badge — colored pill showing tool name (text only, no icon)
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

export function ToolBadge({ color, textColor = '#fff', label }: ToolBadgeProps): React.JSX.Element {
  return (
    <span className="crispy-tool-badge" style={{ background: color, color: textColor }}>
      {label}
    </span>
  );
}
