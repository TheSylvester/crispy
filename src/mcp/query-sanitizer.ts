/**
 * FTS5 Query Sanitizer — validates and sanitizes search queries before MATCH.
 *
 * Strips unbalanced quotes, escapes stray special characters, preserves valid
 * FTS5 operators (AND, OR, NOT, NEAR, quoted phrases, prefix *), and falls
 * back to implicit-AND (space-separated quoted tokens) for unsafe input.
 *
 * IMPORTANT: unicode61 tokenizer treats hyphens and underscores as token
 * separators, so `claude-transcript` is indexed as two tokens: `claude` +
 * `transcript`. Worse, FTS5 query syntax interprets `-` as the NOT operator,
 * so a raw `claude-transcript` query means "claude WITHOUT transcript" — the
 * exact opposite of the intent. This sanitizer normalizes hyphens/underscores
 * between word characters into spaces early, before any FTS5 parsing.
 *
 * @module mcp/query-sanitizer
 */

/** FTS5 boolean operators that should be preserved when recognized. */
const FTS5_OPERATORS = /\b(AND|OR|NOT|NEAR)\b/;

/** Characters that are special in FTS5 query syntax. */
const SPECIAL_CHARS = /[*^:{}[\]()]/g;

/**
 * Normalize hyphens and underscores between word characters into spaces.
 *
 * unicode61 tokenizer splits on these anyway, so `claude-transcript` is
 * stored as two tokens. But at query time, `-` means NOT in FTS5, so
 * `claude-transcript` would mean "claude WITHOUT transcript". Converting
 * to spaces makes it an implicit AND, matching the user's intent.
 *
 * Preserves hyphens/underscores at word boundaries (e.g. leading `-` for
 * NOT) and inside quoted strings.
 */
function normalizeTokenSeparators(input: string): string {
  // Split on quoted strings to preserve them, normalize only unquoted parts
  const parts = input.split(/("(?:[^"\\]|\\.)*")/);
  return parts
    .map((part, i) => {
      // Odd indices are quoted strings — leave them alone
      if (i % 2 === 1) return part;
      // Replace word-hyphen-word and word-underscore-word with spaces
      return part.replace(/(\w)[-_](\w)/g, '$1 $2');
    })
    .join('');
}

/**
 * Sanitize a raw search string for use in FTS5 MATCH.
 *
 * Returns the sanitized query string, or `null` if the input is
 * empty/whitespace-only (callers should skip the MATCH entirely).
 */
export function sanitizeFts5Query(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Normalize hyphens/underscores between word chars into spaces FIRST,
  // before FTS5 can misinterpret `-` as the NOT operator.
  const normalized = normalizeTokenSeparators(trimmed);

  // Balance double-quotes: if odd count, strip all quotes and fall through
  const quoteCount = (normalized.match(/"/g) ?? []).length;
  const balanced = quoteCount % 2 === 0 ? normalized : normalized.replace(/"/g, '');

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

  // 2 words — implicit AND (high precision, usually fine)
  if (words.length <= 2) return words.map((w) => `"${w}"`).join(' ');

  // 3+ words — implicit OR (recall over precision; BM25 ranks multi-word matches higher)
  return words.map((w) => `"${w}"`).join(' OR ');
}
