/**
 * useSessionCwd — derive CWD display from the selected session's projectSlug
 *
 * Claude's projectSlug is the absolute path with '/' → '-' and a leading '-',
 * e.g. `-home-silver-dev-crispy` → `/home/silver/dev/crispy`.
 *
 * Returns:
 *   fullPath  — the reconstructed absolute path (or null)
 *   display   — last 2 segments for compact display (e.g. "dev/crispy")
 *
 * @module useSessionCwd
 */

import { useMemo } from 'react';
import { useSession } from '../context/SessionContext.js';

interface SessionCwd {
  /** Reconstructed full path, e.g. "/home/silver/dev/crispy" */
  fullPath: string | null;
  /** Last two path segments for compact display, e.g. "dev/crispy" */
  display: string | null;
}

/**
 * Reverse Claude's slug encoding: leading '-' removed, remaining '-' → '/'.
 *
 * Heuristic — works for Unix paths where directory names don't contain dashes.
 * Good enough for display; falls back gracefully to the raw slug for edge cases.
 */
function slugToPath(slug: string): string {
  // Strip the leading '-' that represents the root '/'
  const stripped = slug.startsWith('-') ? slug.slice(1) : slug;
  return '/' + stripped.replace(/-/g, '/');
}

function formatCwd(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean);
  return segments.slice(-2).join('/');
}

export function useSessionCwd(): SessionCwd {
  const { sessions, selectedSessionId } = useSession();

  return useMemo(() => {
    if (!selectedSessionId) return { fullPath: null, display: null };

    const session = sessions.find((s) => s.sessionId === selectedSessionId);
    if (!session?.projectSlug) return { fullPath: null, display: null };

    const fullPath = slugToPath(session.projectSlug);
    return { fullPath, display: formatCwd(fullPath) };
  }, [sessions, selectedSessionId]);
}
