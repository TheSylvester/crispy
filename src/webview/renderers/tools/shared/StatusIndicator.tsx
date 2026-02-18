/**
 * Status Indicator — icon for tool completion status
 *
 * Matches Leto style: just an icon, positioned at the end of the summary.
 * Shows result summary text when available.
 *
 * @module webview/renderers/tools/shared/StatusIndicator
 */

const STATUS_CONFIG: Record<string, { icon: string; className: string }> = {
  running: { icon: '\u23f3', className: 'crispy-status-pending' },
  complete: { icon: '\u2713', className: 'crispy-status-success' },
  error: { icon: '\u2717', className: 'crispy-status-error' },
};

interface StatusIndicatorProps {
  status: string;
  summary?: string;
}

export function StatusIndicator({ status, summary }: StatusIndicatorProps): React.JSX.Element {
  const config = STATUS_CONFIG[status] ?? { icon: '?', className: 'crispy-status-pending' };
  const icon = status === 'running'
    ? <span className="crispy-status-spinner" />
    : config.icon;
  return (
    <span className={`crispy-tool-status ${config.className}`}>
      {icon}
      {status === 'complete' && summary ? ` ${summary}` : ''}
      {status === 'error' && summary ? ` ${summary}` : ''}
    </span>
  );
}
