/**
 * SessionGroupHeader — time group header for the session list
 *
 * Renders an uppercase group label.
 * Not focusable or clickable — keyboard navigation skips these.
 *
 * @module SessionGroupHeader
 */

interface SessionGroupHeaderProps {
  label: string;
}

export function SessionGroupHeader({ label }: SessionGroupHeaderProps): React.JSX.Element {
  return (
    <div className="crispy-session-group-header">
      {label.toUpperCase()}
    </div>
  );
}
