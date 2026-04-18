/**
 * Format Utilities — shared formatting helpers for the webview
 *
 * @module webview/utils/format
 */

/**
 * Format a byte count as B / KB / MB / GB.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Format a duration in seconds into a human-readable string.
 *
 * @param seconds  Duration in seconds.
 * @param style    'short' → "5m", "2h 15m"; 'long' → "5 minutes", "2 hours".
 *                 Defaults to 'short'.
 */
export function formatDuration(seconds: number, style: 'short' | 'long' = 'short'): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) {
    return style === 'long' ? `${mins} minute${mins !== 1 ? 's' : ''}` : `${mins}m`;
  }
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (style === 'long') {
    const hLabel = `${hrs} hour${hrs !== 1 ? 's' : ''}`;
    return rem > 0 ? `${hLabel} ${rem}m` : hLabel;
  }
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

/**
 * Format an ISO date string as compact relative time: "now", "5m", "3h", "2d"
 */
export function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (isNaN(then)) return '';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;

  const years = Math.floor(days / 365);
  return `${years}y`;
}
