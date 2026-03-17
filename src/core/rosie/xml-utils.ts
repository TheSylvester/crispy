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
