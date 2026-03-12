/**
 * Format Utilities — shared formatting helpers for the webview
 *
 * @module webview/utils/format
 */

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
