/**
 * Linkify — single-pass text scanner for file references
 *
 * Tokenizes text by whitespace and identifies file references using:
 * 1. Structural path detection (starts with ./ ../ ~/ / or contains /)
 * 2. :line:col suffix extraction (only with path-like prefix)
 * 3. Index-based matching (for bare filenames with extensions)
 *
 * Guards against false positives: URL schemes, all-numeric prefixes,
 * timestamps, bare filenames matching >5 index entries.
 *
 * @module linkify
 */

import type { FileMatch, FileIndex } from './file-index.js';

export interface TextSegment {
  type: 'text';
  value: string;
}

export interface FileLinkSegment {
  type: 'file-link';
  /** Display text (includes surrounding context like backticks) */
  display: string;
  /** The clean file token for matching */
  token: string;
  /** Resolved matches from the index */
  matches: FileMatch[];
  /** Line number (1-based) */
  line?: number;
  /** End line number for ranges like :10-20 (1-based) */
  endLine?: number;
  /** Column number (1-based) */
  col?: number;
}

export type Segment = TextSegment | FileLinkSegment;

/** URL schemes to skip (case-insensitive prefix match). */
const URL_SCHEMES = /^(https?|ftp|wss?|file|mailto|data|blob):\/?\/?/i;

/** Structural path: starts with ./ ../ ~/ / followed by at least one non-separator char */
const STRUCTURAL_PATH_RE = /^([.~]?\.?\/[^\s:,;'")\]]+)/;

/** :line[-endLine][:col] suffix */
const LINE_COL_RE = /^(.+?):(\d+)(?:-(\d+))?(?::(\d+))?$/;

/** Check if a string looks like it has a file extension */
function hasExtension(s: string): boolean {
  // Match .ext at end — ext is 1-10 alphanumeric chars
  return /\.[a-zA-Z0-9]{1,10}$/.test(s);
}

/** Check if the prefix portion looks path-like enough for :line:col */
function isPathLike(prefix: string): boolean {
  return prefix.includes('/') || hasExtension(prefix);
}

/**
 * Strip wrapping characters from a token.
 * Returns [stripped, prefix, suffix] where prefix/suffix are what was removed.
 */
function stripWrapping(raw: string): [string, string, string] {
  let prefix = '';
  let suffix = '';
  let token = raw;

  // Strip leading backtick(s)
  while (token.startsWith('`')) {
    prefix += '`';
    token = token.slice(1);
  }
  // Strip leading quotes
  if (token.startsWith('"') || token.startsWith("'")) {
    prefix += token[0];
    token = token.slice(1);
  }

  // Strip trailing backtick(s)
  while (token.endsWith('`')) {
    suffix = '`' + suffix;
    token = token.slice(0, -1);
  }
  // Strip trailing quotes
  if (token.endsWith('"') || token.endsWith("'")) {
    suffix = token[token.length - 1] + suffix;
    token = token.slice(0, -1);
  }
  // Strip trailing punctuation: ,;:)]}
  while (/[,;:)\]}]$/.test(token)) {
    suffix = token[token.length - 1] + suffix;
    token = token.slice(0, -1);
  }

  return [token, prefix, suffix];
}

/**
 * Linkify a text string, producing a mixed array of text and file-link segments.
 *
 * @param text   The raw text to scan
 * @param index  The file index (null = skip index matching, structural paths only)
 */
export function linkifyText(text: string, index: FileIndex | null): Segment[] {
  if (!text) return [{ type: 'text', value: text }];

  const segments: Segment[] = [];
  // Split on whitespace, preserving the whitespace in results
  const parts = text.split(/(\s+)/);

  for (const part of parts) {
    // Whitespace or empty — pass through as text
    if (!part || /^\s+$/.test(part)) {
      appendText(segments, part);
      continue;
    }

    // Strip wrapping characters
    const [stripped, wrapPrefix, wrapSuffix] = stripWrapping(part);

    // Skip if the stripped token is empty
    if (!stripped) {
      appendText(segments, part);
      continue;
    }

    // Skip URL schemes
    if (URL_SCHEMES.test(stripped)) {
      appendText(segments, part);
      continue;
    }

    const link = tryLinkify(stripped, index);
    if (link) {
      // Add wrapping prefix as text
      if (wrapPrefix) appendText(segments, wrapPrefix);
      segments.push(link);
      // Add wrapping suffix as text
      if (wrapSuffix) appendText(segments, wrapSuffix);
    } else {
      appendText(segments, part);
    }
  }

  return segments;
}

function tryLinkify(token: string, index: FileIndex | null): FileLinkSegment | null {
  // 1. Structural path check: starts with ./ ../ ~/ / or absolute path
  const structMatch = STRUCTURAL_PATH_RE.exec(token);
  if (structMatch) {
    const pathPart = structMatch[1];
    // Try to extract :line:col from the full token (path may continue after structMatch)
    const lineColMatch = LINE_COL_RE.exec(token);
    if (lineColMatch && isPathLike(lineColMatch[1])) {
      const path = lineColMatch[1];
      const line = parseInt(lineColMatch[2], 10);
      const endLine = lineColMatch[3] ? parseInt(lineColMatch[3], 10) : undefined;
      const col = lineColMatch[4] ? parseInt(lineColMatch[4], 10) : undefined;
      const matches = index ? index.match(path.replace(/^\.\//, '')) : [];
      return {
        type: 'file-link',
        display: token,
        token: path,
        matches,
        line,
        endLine,
        col,
      };
    }

    // No :line:col — just link the structural path
    const matches = index ? index.match(pathPart.replace(/^\.\//, '')) : [];
    return {
      type: 'file-link',
      display: token,
      token: pathPart,
      matches,
    };
  }

  // 2. :line:col check — only if prefix is path-like
  const lineColMatch = LINE_COL_RE.exec(token);
  if (lineColMatch) {
    const prefix = lineColMatch[1];
    const line = parseInt(lineColMatch[2], 10);
    const endLine = lineColMatch[3] ? parseInt(lineColMatch[3], 10) : undefined;
    const col = lineColMatch[4] ? parseInt(lineColMatch[4], 10) : undefined;

    // Skip all-numeric prefixes (timestamps like 12:34:56)
    if (/^\d+$/.test(prefix)) return null;

    // Must be path-like OR match index
    const indexHits = index ? index.match(prefix) : [];
    if (isPathLike(prefix) || indexHits.length > 0) {
      return {
        type: 'file-link',
        display: token,
        token: prefix,
        matches: indexHits,
        line,
        endLine,
        col,
      };
    }
  }

  // 3. Index scan — only for tokens with a file extension
  if (index && hasExtension(token) && !token.includes(' ')) {
    const matches = index.match(token);
    if (matches.length > 0) {
      return {
        type: 'file-link',
        display: token,
        token,
        matches,
      };
    }
  }

  return null;
}

/** Append text to segments, merging with the last text segment if possible. */
function appendText(segments: Segment[], value: string): void {
  if (!value) return;
  const last = segments[segments.length - 1];
  if (last && last.type === 'text') {
    last.value += value;
  } else {
    segments.push({ type: 'text', value });
  }
}
