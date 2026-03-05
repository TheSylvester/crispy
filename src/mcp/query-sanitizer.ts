/**
 * FTS5 Query Sanitizer — validates and sanitizes search queries before MATCH.
 *
 * Strips unbalanced quotes, escapes stray special characters, preserves valid
 * FTS5 operators (AND, OR, NOT, NEAR, quoted phrases, prefix *), and falls
 * back to implicit-AND (space-separated quoted tokens) for unsafe input.
 *
 * @module mcp/query-sanitizer
 */

/** FTS5 boolean operators that should be preserved when recognized. */
const FTS5_OPERATORS = /\b(AND|OR|NOT|NEAR)\b/;

/** Characters that are special in FTS5 query syntax. */
const SPECIAL_CHARS = /[*^:{}[\]()]/g;

/**
 * Sanitize a raw search string for use in FTS5 MATCH.
 *
 * Returns the sanitized query string, or `null` if the input is
 * empty/whitespace-only (callers should skip the MATCH entirely).
 */
export function sanitizeFts5Query(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Balance double-quotes: if odd count, strip all quotes and fall through
  const quoteCount = (trimmed.match(/"/g) ?? []).length;
  const balanced = quoteCount % 2 === 0 ? trimmed : trimmed.replace(/"/g, '');

  // If the input contains recognized FTS5 operators and looks well-formed,
  // do a light sanitize (strip truly dangerous chars) and pass through.
  if (FTS5_OPERATORS.test(balanced)) {
    // Strip characters that could cause parse errors but keep * for prefix
    const cleaned = balanced
      .replace(/[^a-zA-Z0-9\s"*.\-_'/]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned;
  }

  // Check for a valid prefix search (word*)
  if (/^"[^"]+"\s*$/.test(balanced) || /^[\w]+\*?\s*$/.test(balanced)) {
    return balanced;
  }

  // Fallback: split into words and wrap each in quotes (implicit AND)
  const words = balanced
    .replace(SPECIAL_CHARS, '')
    .replace(/"/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return null;

  // Single word — just return as-is
  if (words.length === 1) return words[0]!;

  // Multiple words — quote each token for implicit AND
  return words.map((w) => `"${w}"`).join(' ');
}
