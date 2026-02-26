/**
 * useCwd — CWD state derived from SessionContext's selectedCwd (projectSlug)
 *
 * Uses `projectPath` from SessionInfo when available (the real absolute path
 * extracted from JSONL entries). Falls back to the lossy `slugToPath()` only
 * when no session in the current slug has a projectPath.
 *
 * Returns:
 *   slug     — the raw projectSlug (dropdown value / canonical key)
 *   fullPath — the real absolute path (or lossy fallback)
 *   display  — last 2 segments for compact display (e.g. "dev/crispy")
 *
 * @module useSessionCwd
 */

import { useMemo } from 'react';
import { useSession } from '../context/SessionContext.js';

export interface CwdInfo {
  /** Raw projectSlug — canonical key for the dropdown */
  slug: string | null;
  /** Real absolute path (from projectPath) or lossy fallback from slugToPath */
  fullPath: string | null;
  /** Last two path segments for compact display, e.g. "dev/crispy" */
  display: string | null;
}

/**
 * Reverse Claude's slug encoding: leading '-' removed, remaining '-' → '/'.
 *
 * @deprecated Lossy — breaks paths with hyphens (e.g. `/home/user/my-project`
 * becomes `/home/user/my/project`). Use `SessionInfo.projectPath` instead,
 * which carries the real path extracted from JSONL entries. This function is
 * retained only as a fallback for sessions that pre-date projectPath extraction.
 */
export function slugToPath(slug: string): string {
  // Strip the leading '-' that represents the root '/'
  const stripped = slug.startsWith('-') ? slug.slice(1) : slug;
  return '/' + stripped.replace(/-/g, '/');
}

/**
 * Convert an absolute path to Claude's slug format: '/' → '-'.
 * e.g. `/home/user/projects/my-app` → `-home-user-projects-my-app`
 *
 * Inverse of slugToPath() — used to convert a workspace folder path into
 * the slug format used by selectedCwd / projectSlug.
 */
export function pathToSlug(absPath: string): string {
  return absPath.replace(/[\\/]/g, '-');
}

export function formatCwd(fullPath: string): string {
  const segments = fullPath.split(/[\\/]/).filter(Boolean);
  return segments.slice(-2).join('/');
}

/**
 * Primary CWD hook — reads selectedCwd from SessionContext.
 *
 * Looks up `projectPath` from the sessions list to get the real absolute
 * path. Falls back to the lossy `slugToPath()` only when no session in
 * the current slug has a projectPath.
 */
export function useCwd(): CwdInfo {
  const { selectedCwd, sessions } = useSession();

  return useMemo(() => {
    if (!selectedCwd) return { slug: null, fullPath: null, display: null };

    // Find the real project path from any session sharing this slug
    const realPath = sessions.find(
      (s) => s.projectSlug === selectedCwd && s.projectPath,
    )?.projectPath;

    const fullPath = realPath ?? slugToPath(selectedCwd);
    return { slug: selectedCwd, fullPath, display: formatCwd(fullPath) };
  }, [selectedCwd, sessions]);
}

/** @deprecated Use `useCwd()` instead — kept for backwards compatibility */
export function useSessionCwd(): { fullPath: string | null; display: string | null } {
  const { fullPath, display } = useCwd();
  return { fullPath, display };
}
