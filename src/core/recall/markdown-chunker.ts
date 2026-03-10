/**
 * Markdown Chunker — Header-based text splitting for RAG pipelines
 *
 * Splits markdown text into semantically coherent chunks based on header
 * hierarchy. Designed for FTS5 indexing and embedding with Nomic Embed Code.
 * Handles 6+ GB of transcript data across 17k+ sessions.
 *
 * Splitting strategy (in priority order):
 * 1. Headers (h1–h6) — each chunk = header + body until next equal/higher header
 * 2. Paragraphs (\n\n) — sub-split oversized chunks, preserving header prefix
 * 3. Sentences — last-resort split for paragraphs exceeding maxChunkSize
 *
 * Limitations:
 * - Only ATX-style headers (# through ######). Setext headers (underlined
 *   with === or ---) are intentionally unsupported — they're rare in LLM
 *   transcripts.
 * - Fenced code block detection uses a simple toggle. Nested or unclosed
 *   fences may cause incorrect header detection, but this handles the 99%
 *   case of code blocks in transcripts.
 *
 * Scope: pure text transformation. No I/O, no persistence, no side effects.
 * Boundary: takes a string, returns chunks. Does not know about sessions,
 * transcripts, or embedding models.
 *
 * @module markdown-chunker
 */

// ============================================================================
// Types
// ============================================================================

/** A single chunk of markdown text with position metadata. */
export interface MarkdownChunk {
  /** The chunk text content */
  text: string;
  /** Header level (1-6) or 0 for preamble/headerless chunks */
  headingLevel: number;
  /** The header text (without # prefix), or empty for preamble */
  heading: string;
  /** Zero-based index of this chunk in the output array */
  index: number;
  /** Character offset in the normalized text where this chunk starts */
  startOffset: number;
  /** Character offset in the normalized text where this chunk ends */
  endOffset: number;
}

/** Options for controlling chunk size and overlap. */
export interface ChunkOptions {
  /** Max characters per chunk. Default: 2000 */
  maxChunkSize?: number;
  /** Overlap characters between consecutive chunks. Default: 0 */
  overlap?: number;
  /** Minimum chunk size — chunks smaller than this get merged with the next. Default: 100 */
  minChunkSize?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_CHUNK_SIZE = 2000;
const DEFAULT_OVERLAP = 0;
const DEFAULT_MIN_CHUNK_SIZE = 100;

/** Matches ATX-style markdown headers: # through ###### */
const HEADER_RE = /^(#{1,6})\s+(.*)$/;

/** Matches fenced code block delimiters (backticks or tildes, 3+) */
const FENCE_RE = /^(`{3,}|~{3,})/;

/**
 * Sentence boundary regex. Splits on period/question/exclamation followed by
 * whitespace, but avoids splitting on common abbreviations and decimals.
 * Not perfect — inherent limitation for any regex-based sentence splitter.
 */
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z\u00C0-\u024F])/;

// ============================================================================
// Internal types
// ============================================================================

/** A raw section parsed from headers before size processing. */
interface RawSection {
  headingLevel: number;
  heading: string;
  body: string;
  startOffset: number;
  endOffset: number;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Split markdown text into chunks based on header hierarchy.
 *
 * Input is normalized (CRLF → LF) before processing. Offsets in the output
 * reference positions in the normalized text.
 *
 * Returns an empty array for empty/whitespace-only input.
 */
export function chunkMarkdown(text: string, options?: ChunkOptions): MarkdownChunk[] {
  if (!text || !/\S/.test(text)) return [];

  // Normalize CRLF → LF before any processing
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const maxChunkSize = options?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;
  const minChunkSize = options?.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;

  // Step 1: Parse into raw sections by header hierarchy
  const sections = parseHeaderSections(normalized);

  // Step 2: Merge undersized sections
  const merged = mergeSmallSections(sections, minChunkSize);

  // Step 3: Sub-split oversized sections
  const sized = subSplitOversized(merged, maxChunkSize, normalized);

  // Step 4: Apply overlap
  const overlapped = applyOverlap(sized, overlap, normalized);

  // Step 5: Assign final indices
  return overlapped.map((chunk, i) => ({ ...chunk, index: i }));
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse text into raw sections split by ATX headers.
 * Text before the first header becomes a preamble section (level 0).
 * Respects header hierarchy: a section ends when a header of equal or
 * higher level (lower number) is encountered.
 * Skips headers inside fenced code blocks.
 */
function parseHeaderSections(text: string): RawSection[] {
  const lines = text.split('\n');
  const sections: RawSection[] = [];

  interface HeaderPos {
    level: number;
    heading: string;
    offset: number;
  }

  const headers: HeaderPos[] = [];
  let charOffset = 0;
  let inFencedBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      inFencedBlock = !inFencedBlock;
    }

    // Only detect headers outside fenced blocks
    if (!inFencedBlock) {
      const match = line.match(HEADER_RE);
      if (match) {
        headers.push({
          level: match[1].length,
          heading: match[2].trim(),
          offset: charOffset,
        });
      }
    }

    charOffset += line.length + 1; // +1 for \n
  }

  if (headers.length === 0) {
    // No headers at all — return the whole text as a single preamble section
    return [{
      headingLevel: 0,
      heading: '',
      body: text,
      startOffset: 0,
      endOffset: text.length,
    }];
  }

  // Preamble: text before first header
  if (headers[0].offset > 0) {
    const preambleText = text.slice(0, headers[0].offset);
    if (preambleText.trim()) {
      sections.push({
        headingLevel: 0,
        heading: '',
        body: preambleText.trimEnd(),
        startOffset: 0,
        endOffset: headers[0].offset,
      });
    }
  }

  // Build sections from headers using hierarchy-aware boundaries.
  // Each header's section extends to the next header of equal or higher level.
  for (let i = 0; i < headers.length; i++) {
    const current = headers[i];

    let j = i + 1;
    while (j < headers.length && headers[j].level > current.level) {
      j++;
    }

    const endOffset = j < headers.length ? headers[j].offset : text.length;
    const sectionText = text.slice(current.offset, endOffset);

    // Trim trailing whitespace from the body text, and adjust endOffset
    // to match so body.length === endOffset - startOffset.
    const trimmed = sectionText.trimEnd();
    const trimmedEndOffset = current.offset + trimmed.length;

    sections.push({
      headingLevel: current.level,
      heading: current.heading,
      body: trimmed,
      startOffset: current.offset,
      endOffset: trimmedEndOffset,
    });
  }

  return sections;
}

// ============================================================================
// Merging
// ============================================================================

/**
 * Merge sections smaller than minChunkSize into the next section.
 * Rules:
 * - Preamble sections (level 0) are never merged.
 * - A small section only merges into the next if the next section is at a
 *   strictly deeper level (higher number). This means a tiny h2 header
 *   with no body merges with its child h3, but two sibling h2s stay
 *   separate — merging peers destroys semantic boundaries.
 * - Because hierarchy parsing already nests children under parents, merging
 *   uses the next section's body directly (not concatenation which would
 *   duplicate content).
 */
function mergeSmallSections(sections: RawSection[], minChunkSize: number): RawSection[] {
  if (sections.length <= 1) return sections;

  const result: RawSection[] = [];
  let pending: RawSection | null = null;

  for (const section of sections) {
    if (pending) {
      if (section.headingLevel > pending.headingLevel) {
        // Next section is deeper — pending (parent) already includes this
        // child's content via hierarchy parsing. Just extend the parent's
        // span to cover the child and drop the child section.
        result.push({
          headingLevel: pending.headingLevel,
          heading: pending.heading,
          body: pending.body,
          startOffset: pending.startOffset,
          endOffset: Math.max(pending.endOffset, section.endOffset),
        });
      } else {
        // Same or higher level — emit both independently
        result.push(pending);
        result.push(section);
      }
      pending = null;
    } else if (section.body.trim().length < minChunkSize && section.headingLevel > 0) {
      // Too small and not preamble — hold for merging with next
      pending = section;
    } else {
      result.push(section);
    }
  }

  if (pending) {
    result.push(pending);
  }

  return result;
}

// ============================================================================
// Sub-splitting
// ============================================================================

/**
 * Split oversized sections into smaller chunks.
 * Strategy: split by paragraphs first, then by sentences as last resort.
 * Each sub-chunk preserves the header as a prefix.
 *
 * Offset tracking: we find the actual positions of paragraph content within
 * the original text to produce accurate offsets.
 */
function subSplitOversized(
  sections: RawSection[],
  maxChunkSize: number,
  originalText: string,
): MarkdownChunk[] {
  const chunks: MarkdownChunk[] = [];

  for (const section of sections) {
    if (section.body.length <= maxChunkSize) {
      chunks.push({
        text: section.body,
        headingLevel: section.headingLevel,
        heading: section.heading,
        index: 0, // assigned later
        startOffset: section.startOffset,
        endOffset: section.endOffset,
      });
      continue;
    }

    // Extract header line and body content
    const headerLine = section.headingLevel > 0
      ? '#'.repeat(section.headingLevel) + ' ' + section.heading
      : '';
    const headerPrefix = headerLine ? headerLine + '\n\n' : '';

    // Find where the body content starts (after the header line + newlines)
    let bodyStartOffset = section.startOffset;
    if (section.headingLevel > 0) {
      const newlinePos = section.body.indexOf('\n');
      if (newlinePos !== -1) {
        bodyStartOffset = section.startOffset + newlinePos + 1;
        // Skip leading newlines after header
        while (bodyStartOffset < section.endOffset &&
               originalText[bodyStartOffset] === '\n') {
          bodyStartOffset++;
        }
      }
    }

    const bodyContent = originalText.slice(bodyStartOffset, section.endOffset);
    const subChunkTexts = splitByParagraphs(bodyContent, maxChunkSize, headerPrefix);

    // Map sub-chunks to offsets by searching for paragraph content in the
    // original text. This handles variable-length paragraph separators
    // correctly.
    let searchFrom = bodyStartOffset;
    for (const subText of subChunkTexts) {
      // The sub-chunk text = headerPrefix + actual body content.
      // Extract the body portion to find its position in original text.
      const bodyPortion = subText.startsWith(headerPrefix)
        ? subText.slice(headerPrefix.length)
        : subText;

      // Find where this body portion starts in the original text
      const bodyPos = bodyPortion.length > 0
        ? originalText.indexOf(bodyPortion, searchFrom)
        : searchFrom;

      const startOffset = bodyPos !== -1 ? bodyPos : searchFrom;
      const endOffset = startOffset + bodyPortion.length;

      chunks.push({
        text: subText,
        headingLevel: section.headingLevel,
        heading: section.heading,
        index: 0,
        startOffset,
        endOffset: Math.min(endOffset, section.endOffset),
      });

      // Advance search position past this chunk
      if (bodyPos !== -1) {
        searchFrom = bodyPos + bodyPortion.length;
      }
    }
  }

  return chunks;
}

/**
 * Split body text by paragraph boundaries, prepending headerPrefix to each chunk.
 * Falls back to sentence splitting for paragraphs that still exceed maxChunkSize.
 */
function splitByParagraphs(
  body: string,
  maxChunkSize: number,
  headerPrefix: string,
): string[] {
  const paragraphs = body.split(/\n\n+/);
  const maxBody = maxChunkSize - headerPrefix.length;
  const results: string[] = [];
  let current = '';

  // Guard against headerPrefix being larger than maxChunkSize
  if (maxBody <= 0) {
    return [headerPrefix + body];
  }

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current && (current.length + 2 + trimmed.length) > maxBody) {
      // Flush current
      results.push(headerPrefix + current.trim());
      current = '';
    }

    if (trimmed.length > maxBody) {
      // Flush anything accumulated
      if (current.trim()) {
        results.push(headerPrefix + current.trim());
        current = '';
      }
      // Split this paragraph by sentences
      const sentenceChunks = splitBySentences(trimmed, maxBody);
      for (const sc of sentenceChunks) {
        results.push(headerPrefix + sc);
      }
    } else {
      current = current ? current + '\n\n' + trimmed : trimmed;
    }
  }

  if (current.trim()) {
    results.push(headerPrefix + current.trim());
  }

  // Edge case: if body was empty after splitting, return the header alone
  if (results.length === 0 && headerPrefix.trim()) {
    results.push(headerPrefix.trim());
  }

  return results;
}

/**
 * Last-resort split by sentence boundaries.
 * If a single sentence exceeds maxSize, hard-split by character count.
 */
function splitBySentences(text: string, maxSize: number): string[] {
  const sentences = text.split(SENTENCE_SPLIT_RE);
  const results: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (current && (current.length + 1 + trimmed.length) > maxSize) {
      results.push(current.trim());
      current = '';
    }

    if (trimmed.length > maxSize) {
      // Hard split
      if (current.trim()) {
        results.push(current.trim());
        current = '';
      }
      for (let i = 0; i < trimmed.length; i += maxSize) {
        results.push(trimmed.slice(i, i + maxSize));
      }
    } else {
      current = current ? current + ' ' + trimmed : trimmed;
    }
  }

  if (current.trim()) {
    results.push(current.trim());
  }

  return results;
}

// ============================================================================
// Overlap
// ============================================================================

/**
 * Apply overlap between consecutive chunks by prepending trailing text
 * from the original source at the previous chunk's end position.
 *
 * Uses the original text to extract overlap content, avoiding the problem
 * of pulling header prefixes from sub-split chunk text. The overlap is
 * purely additive — offsets still reflect the non-overlapped position.
 */
function applyOverlap(chunks: MarkdownChunk[], overlap: number, originalText: string): MarkdownChunk[] {
  if (overlap <= 0 || chunks.length <= 1) return chunks;

  const result: MarkdownChunk[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const currentChunk = chunks[i];
    // Extract overlap from original text ending at this chunk's start
    const overlapEnd = currentChunk.startOffset;
    const overlapStart = Math.max(0, overlapEnd - overlap);
    const overlapText = originalText.slice(overlapStart, overlapEnd);

    // Find a clean break point (whitespace) to avoid splitting words
    const cleanBreak = findCleanBreak(overlapText);
    const cleanOverlap = cleanBreak > 0 ? overlapText.slice(cleanBreak) : overlapText;

    if (cleanOverlap.trim()) {
      result.push({
        ...currentChunk,
        text: cleanOverlap.trim() + '\n\n' + currentChunk.text,
      });
    } else {
      result.push(currentChunk);
    }
  }

  return result;
}

/**
 * Find the first whitespace position in a string for a clean word break.
 * Returns 0 if no whitespace found.
 */
function findCleanBreak(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ' || text[i] === '\n' || text[i] === '\t') {
      return i + 1; // skip the whitespace character
    }
  }
  return 0;
}
