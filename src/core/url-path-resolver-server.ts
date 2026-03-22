/**
 * URL Path Resolver (Server) — server-only path conversion
 *
 * Separated from url-path-resolver.ts because it imports `os.homedir()`,
 * which is unavailable in the browser bundle (esbuild --platform=browser).
 *
 * @module url-path-resolver-server
 */

import { homedir } from 'os';

// Re-export browser-safe functions for convenience
export { fsPathToUrlPath, normalizePath } from './url-path-resolver.js';

/**
 * Convert a URL path to a filesystem path.
 *
 * Only call AFTER routing confirms this is a workspace path (not `/`,
 * not a static asset, not `/health`/`/ws`/etc.).
 */
export function urlPathToFsPath(urlPath: string): string {
  const decoded = decodeURIComponent(urlPath);

  // Strip leading slash to get the raw path content
  const stripped = decoded.startsWith('/') ? decoded.slice(1) : decoded;

  // Tilde: ~/dev/crispy → /home/user/dev/crispy (or C:\Users\user\dev\crispy)
  if (stripped.startsWith('~/') || stripped === '~') {
    const home = homedir();
    const rest = stripped.slice(1); // remove '~', keep leading '/'
    // Use platform-native separators so round-trip with fsPathToUrlPath works
    return home + (home.includes('\\') ? rest.replace(/\//g, '\\') : rest);
  }

  // Windows drive letter: C:/Users/... → C:\Users\...
  if (/^[A-Za-z]:\//.test(stripped)) {
    return stripped.replace(/\//g, '\\');
  }

  // Unix absolute: /home/user/... (leading slash was stripped, add it back)
  return '/' + stripped;
}
