/**
 * File Index — match engine for linkifying file references
 *
 * Builds an in-memory index from git file paths, supporting exact,
 * suffix (at `/` boundaries), and basename matching with configurable
 * match limits. Multi-match results are sorted shortest-path-first.
 *
 * @module file-index
 */

export interface FileMatch {
  /** Relative path from repo root (e.g. "src/utils/foo.ts") */
  relativePath: string;
  /** Absolute path on disk (e.g. "/home/user/repo/src/utils/foo.ts") */
  absolutePath: string;
}

export interface FileIndex {
  /** Find files matching a token. Priority: exact → suffix → basename. */
  match(token: string): FileMatch[];
  /** Substring search across all indexed paths. Returns up to `limit` matches. */
  search(query: string, limit?: number): FileMatch[];
  /** Total number of indexed files. */
  size: number;
}

/** Maximum basename matches before we consider it too noisy. */
const MAX_BASENAME_MATCHES = 5;

/**
 * Build a match index from git file paths.
 *
 * @param gitFiles  Relative file paths from `git ls-files`
 * @param cwd       Absolute repo root (to construct absolute paths)
 */
export function buildMatchIndex(gitFiles: string[], cwd: string): FileIndex {
  // Normalize cwd to not have trailing slash
  const root = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;

  // 1. Exact map: full relative path → single FileMatch
  const exactMap = new Map<string, FileMatch>();

  // 2. Suffix map: every suffix at `/` boundaries → FileMatch[]
  const suffixMap = new Map<string, FileMatch[]>();

  // 3. Basename map: filename with extension → FileMatch[]
  const basenameMap = new Map<string, FileMatch[]>();

  for (const rel of gitFiles) {
    const fm: FileMatch = {
      relativePath: rel,
      absolutePath: `${root}/${rel}`,
    };

    // Exact
    exactMap.set(rel, fm);

    // Suffix: generate suffixes at each `/` boundary
    // For "src/utils/foo.ts" → ["utils/foo.ts", "foo.ts"]
    let idx = 0;
    while ((idx = rel.indexOf("/", idx)) !== -1) {
      const suffix = rel.slice(idx + 1);
      if (suffix) {
        const arr = suffixMap.get(suffix);
        if (arr) {
          arr.push(fm);
        } else {
          suffixMap.set(suffix, [fm]);
        }
      }
      idx++;
    }

    // Basename: just the filename
    const lastSlash = rel.lastIndexOf("/");
    const basename = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
    if (basename) {
      const arr = basenameMap.get(basename);
      if (arr) {
        arr.push(fm);
      } else {
        basenameMap.set(basename, [fm]);
      }
    }
  }

  const byDepth = (a: FileMatch, b: FileMatch) =>
    a.relativePath.split('/').length - b.relativePath.split('/').length;

  return {
    match(token: string): FileMatch[] {
      // 1. Exact match
      const exact = exactMap.get(token);
      if (exact) return [exact];

      // 2. Suffix match (also covers exact since suffix includes full paths at boundaries)
      const suffixHits = suffixMap.get(token);
      if (suffixHits && suffixHits.length > 0) return [...suffixHits].sort(byDepth);

      // 3. Basename match — only if token has a `.` extension, no `/`, and ≤ MAX matches
      if (!token.includes("/") && token.includes(".")) {
        const basenameHits = basenameMap.get(token);
        if (basenameHits && basenameHits.length > 0 && basenameHits.length <= MAX_BASENAME_MATCHES) {
          return [...basenameHits].sort(byDepth);
        }
      }

      return [];
    },
    search(query: string, limit = 15): FileMatch[] {
      const results: FileMatch[] = [];
      if (!query) {
        // Empty query → return first N files (alphabetical, matching git ls-files order)
        for (const fm of exactMap.values()) {
          results.push(fm);
          if (results.length >= limit) break;
        }
        return results;
      }
      const lower = query.toLowerCase();
      for (const fm of exactMap.values()) {
        if (fm.relativePath.toLowerCase().includes(lower)) {
          results.push(fm);
          if (results.length >= limit) break;
        }
      }
      return results;
    },
    get size() {
      return exactMap.size;
    },
  };
}
