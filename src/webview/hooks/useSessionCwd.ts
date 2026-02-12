/**
 * useCwd — CWD state derived from SessionContext's selectedCwd (projectSlug)
 *
 * Claude's projectSlug is the absolute path with '/' → '-' and a leading '-',
 * e.g. `-home-silver-dev-crispy` → `/home/silver/dev/crispy`.
 *
 * Returns:
 *   slug     — the raw projectSlug (dropdown value / canonical key)
 *   fullPath — the reconstructed absolute path (or null)
 *   display  — last 2 segments for compact display (e.g. "dev/crispy")
 *
 * @module useSessionCwd
 */

import { useMemo } from 'react';
import { useSession } from '../context/SessionContext.js';

export interface CwdInfo {
  /** Raw projectSlug — canonical key for the dropdown */
  slug: string | null;
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
export function slugToPath(slug: string): string {
  // Strip the leading '-' that represents the root '/'
  const stripped = slug.startsWith('-') ? slug.slice(1) : slug;
  return '/' + stripped.replace(/-/g, '/');
}

export function formatCwd(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean);
  return segments.slice(-2).join('/');
}

/**
 * Primary CWD hook — reads selectedCwd from SessionContext.
 *
 * Replaces the old useSessionCwd that derived CWD from selectedSessionId.
 * Now reads the context-managed selectedCwd slug, which auto-syncs on
 * session selection but can also be set independently.
 */
export function useCwd(): CwdInfo {
  const { selectedCwd } = useSession();

  return useMemo(() => {
    if (!selectedCwd) return { slug: null, fullPath: null, display: null };

    const fullPath = slugToPath(selectedCwd);
    return { slug: selectedCwd, fullPath, display: formatCwd(fullPath) };
  }, [selectedCwd]);
}

/** @deprecated Use `useCwd()` instead — kept for backwards compatibility */
export function useSessionCwd(): { fullPath: string | null; display: string | null } {
  const { fullPath, display } = useCwd();
  return { fullPath, display };
}
