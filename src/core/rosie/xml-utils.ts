/**
 * Rosie XML Utilities — Shared helpers for parsing XML-tagged LLM responses
 *
 * Used by both summarize-hook and tracker to extract structured data from
 * XML-tagged model output. Regex-based — not a full XML parser.
 *
 * @module rosie/xml-utils
 */

// ============================================================================
// Tag Extraction
// ============================================================================

/**
 * Extract the text content of an XML tag from a response string.
 * Returns empty string if the tag is not found.
 */
export function extractTag(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1]?.trim() ?? '';
}

// ============================================================================
// Entities Normalization
// ============================================================================

/**
 * Normalize a raw entities string into a valid JSON array string.
 *
 * Tries JSON.parse first; falls back to comma-splitting and quote-stripping.
 * Always returns a valid JSON array string (defaults to '[]').
 *
 * Used by summarize-hook.
 */
export function normalizeEntitiesJson(raw: string): string {
  if (!raw) return '[]';

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
  } catch {
    // Fall back: split on commas, trim quotes/whitespace, wrap as JSON array
  }

  const items = raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return JSON.stringify(items);
}
