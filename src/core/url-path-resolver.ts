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
  const sep = home.includes('\\') ? '\\' : '/';

  // Home-relative shorthand
  if (fsPath === home || fsPath.startsWith(home + sep)) {
    return '/~' + fsPath.slice(home.length).replace(/\\/g, '/');
  }

  // Windows: C:\Users\... → /C:/Users/...
  if (/^[A-Za-z]:\\/.test(fsPath)) {
    return '/' + fsPath.replace(/\\/g, '/');
  }

  // Unix absolute: already starts with /
  return fsPath;
}

/**
 * Normalize a path for comparison: forward slashes, lowercase drive letter,
 * no trailing slash.
 */
export function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/');
  // Lowercase Windows drive letter for comparison
  normalized = normalized.replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase() + ':');
  // Remove trailing slash (but keep bare '/')
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
