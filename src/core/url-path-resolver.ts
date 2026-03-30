/**
 * URL Path Resolver — bidirectional conversion between URL paths and filesystem paths
 *
 * This file contains ONLY browser-safe functions (no Node imports).
 * Server-only functions live in url-path-resolver-server.ts.
 *
 * @module url-path-resolver
 */

// ============================================================================
// Browser-safe (no Node imports)
// ============================================================================

/**
 * Convert a filesystem path to a URL path.
 *
 * `home` is the user's home directory, passed explicitly so this function
 * works in the browser without importing `os`.
 */
export function fsPathToUrlPath(fsPath: string, home: string): string {
  // Strip Windows extended-length path prefix (\\?\)
  if (fsPath.startsWith('\\\\?\\')) fsPath = fsPath.slice(4);
  if (home.startsWith('\\\\?\\')) home = home.slice(4);

  // Normalize both to forward slashes so comparison works regardless of
  // whether inputs use native separators (C:\Users\...) or normalized
  // form (c:/users/...) from workspace-roots.ts.
  const fsNorm = fsPath.replace(/\\/g, '/');
  const homeNorm = home.replace(/\\/g, '/');

  // Home-relative shorthand — case-insensitive on Windows (drive letters, user dirs)
  const fsLower = fsNorm.toLowerCase();
  const homeLower = homeNorm.toLowerCase();
  if (fsLower === homeLower || fsLower.startsWith(homeLower + '/')) {
    return '/~' + encodePathSegments(fsNorm.slice(homeNorm.length));
  }

  // Windows: C:/Users/... or C:\Users\... → /C:/Users/...
  if (/^[A-Za-z]:[/\\]/.test(fsPath)) {
    return '/' + encodePathSegments(fsNorm);
  }

  // Unix absolute: already starts with /
  return encodePathSegments(fsNorm);
}

/** Encode characters that are valid in filenames but break URL routing (#, ?). */
function encodePathSegments(urlPath: string): string {
  return urlPath.replace(/[#?]/g, (c) => encodeURIComponent(c));
}

/**
 * Normalize a path for comparison: forward slashes, lowercase drive letter,
 * no trailing slash.
 */
export function normalizePath(p: string): string {
  // Strip Windows extended-length path prefix (\\?\)
  let normalized = p.startsWith('\\\\?\\') ? p.slice(4) : p;
  normalized = normalized.replace(/\\/g, '/');
  // Lowercase Windows drive letter for comparison
  normalized = normalized.replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase() + ':');
  // Remove trailing slash (but keep bare '/')
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
