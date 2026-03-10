import { describe, it, expect } from 'vitest';
import { chunkMarkdown, type MarkdownChunk, type ChunkOptions } from '../../src/core/recall/markdown-chunker.js';

describe('chunkMarkdown', () => {
  // ==========================================================================
  // Basic header splitting
  // ==========================================================================

  describe('basic header splitting', () => {
    it('splits by h1 headers', () => {
      const text = '# First\n\nBody one.\n\n# Second\n\nBody two.';
      const chunks = chunkMarkdown(text);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].heading).toBe('First');
      expect(chunks[0].headingLevel).toBe(1);
      expect(chunks[0].text).toContain('Body one.');
      expect(chunks[1].heading).toBe('Second');
      expect(chunks[1].text).toContain('Body two.');
    });

    it('splits by h2 headers', () => {
      const text = '## Alpha\n\nContent A.\n\n## Beta\n\nContent B.';
      const chunks = chunkMarkdown(text);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].headingLevel).toBe(2);
      expect(chunks[1].headingLevel).toBe(2);
    });

    it('assigns sequential indices', () => {
      const text = '# A\n\nOne.\n\n# B\n\nTwo.\n\n# C\n\nThree.';
      const chunks = chunkMarkdown(text);
      expect(chunks.map(c => c.index)).toEqual([0, 1, 2]);
    });
  });

  // ==========================================================================
  // Nested headers
  // ==========================================================================

  describe('nested headers', () => {
    it('groups h2 under h1 until next h1', () => {
      const text = [
        '# Chapter 1',
        '',
        'Intro.',
        '',
        '## Section 1.1',
        '',
        'Details.',
        '',
        '# Chapter 2',
        '',
        'More.',
      ].join('\n');

      const chunks = chunkMarkdown(text);
      const ch1 = chunks.find(c => c.heading === 'Chapter 1')!;
      expect(ch1.text).toContain('Section 1.1');
      expect(ch1.text).toContain('Details.');

      const ch2 = chunks.find(c => c.heading === 'Chapter 2')!;
      expect(ch2.text).not.toContain('Section 1.1');
    });

    it('handles h1 > h2 > h3 nesting', () => {
      const text = [
        '# Top',
        '',
        '## Mid',
        '',
        '### Deep',
        '',
        'Content.',
        '',
        '# Another',
        '',
        'Text.',
      ].join('\n');

      const chunks = chunkMarkdown(text);
      const top = chunks.find(c => c.heading === 'Top')!;
      expect(top.text).toContain('Deep');
      expect(top.text).toContain('Content.');
    });
  });

  // ==========================================================================
  // Preamble
  // ==========================================================================

  describe('preamble', () => {
    it('creates preamble chunk for text before first header', () => {
      const text = 'Some preamble text.\n\n# First Header\n\nBody.';
      const chunks = chunkMarkdown(text);
      expect(chunks[0].headingLevel).toBe(0);
      expect(chunks[0].heading).toBe('');
      expect(chunks[0].text).toContain('Some preamble text.');
    });

    it('skips empty preamble', () => {
      const text = '# Header\n\nBody.';
      const chunks = chunkMarkdown(text);
      expect(chunks[0].headingLevel).toBe(1);
    });
  });

  // ==========================================================================
  // maxChunkSize
  // ==========================================================================

  describe('maxChunkSize sub-splitting', () => {
    it('splits oversized sections by paragraph', () => {
      const text = '# Big\n\n' + 'A'.repeat(100) + '\n\n' + 'B'.repeat(100);
      const chunks = chunkMarkdown(text, { maxChunkSize: 150 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.heading).toBe('Big');
        expect(chunk.text).toContain('# Big');
      }
    });

    it('falls back to sentence splitting for huge paragraphs', () => {
      const longPara = Array.from({ length: 20 }, (_, i) =>
        `Sentence number ${i + 1} is here.`
      ).join(' ');
      const text = '# Section\n\n' + longPara;
      const chunks = chunkMarkdown(text, { maxChunkSize: 200 });
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('hard-splits when even sentences exceed maxChunkSize', () => {
      const text = '# X\n\n' + 'A'.repeat(500);
      const chunks = chunkMarkdown(text, { maxChunkSize: 100 });
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  // ==========================================================================
  // overlap
  // ==========================================================================

  describe('overlap', () => {
    it('prepends text from original source near chunk boundary', () => {
      const text = '# A\n\nFirst section content.\n\n# B\n\nSecond section content.';
      const chunks = chunkMarkdown(text, { overlap: 20 });
      expect(chunks.length).toBe(2);
      expect(chunks[1].text).toContain('# B');
    });

    it('does not add overlap to first chunk', () => {
      const text = '# A\n\nContent.\n\n# B\n\nMore.';
      const withOverlap = chunkMarkdown(text, { overlap: 50 });
      const withoutOverlap = chunkMarkdown(text, { overlap: 0 });
      expect(withOverlap[0].text).toBe(withoutOverlap[0].text);
    });

    it('handles overlap larger than previous chunk', () => {
      const text = '# A\n\nHi.\n\n# B\n\nMore content here.';
      const chunks = chunkMarkdown(text, { overlap: 1000 });
      expect(chunks.length).toBe(2);
    });

    it('overlap does not include header prefix from sub-split chunks', () => {
      // If A is sub-split, overlap for B should come from original text,
      // not from the sub-split chunk text (which has a prepended header)
      const text = '# A\n\n' + 'Word '.repeat(100) + '\n\n# B\n\nSecond.';
      const chunks = chunkMarkdown(text, { overlap: 50 });
      const bChunk = chunks.find(c => c.heading === 'B')!;
      // The overlap text should not start with "# A" — it comes from original text
      expect(bChunk.text).not.toMatch(/^# A/);
    });
  });

  // ==========================================================================
  // minChunkSize merging
  // ==========================================================================

  describe('minChunkSize merging', () => {
    it('merges small section into the next deeper section', () => {
      const text = '## Intro\n\n### Detail\n\n' + 'Content here. '.repeat(20);
      const chunks = chunkMarkdown(text, { minChunkSize: 500 });
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.some(c => c.text.includes('Content here.'))).toBe(true);
    });

    it('does not merge small same-level siblings', () => {
      const text = '## A\n\nX\n\n## B\n\nY';
      const chunks = chunkMarkdown(text, { minChunkSize: 50 });
      expect(chunks.length).toBe(2);
    });

    it('does not duplicate child content when merging', () => {
      const text = '# Parent\n\n## Child\n\nChild body here is longer text.\n\n# Next\n\nMore content here is also longer.';
      const chunks = chunkMarkdown(text, { minChunkSize: 200 });
      for (const c of chunks) {
        const count = (c.text.match(/Child body here/g) || []).length;
        expect(count).toBeLessThanOrEqual(1);
      }
    });

    it('keeps small preamble as standalone', () => {
      const text = 'Hi.\n\n## Normal\n\n' + 'Content. '.repeat(20);
      const chunks = chunkMarkdown(text, { minChunkSize: 50 });
      const preamble = chunks.find(c => c.headingLevel === 0);
      expect(preamble).toBeDefined();
    });

    it('emits trailing small section if nothing to merge into', () => {
      const text = '# Big\n\n' + 'Content. '.repeat(20) + '\n\n# Tiny\n\nX';
      const chunks = chunkMarkdown(text, { minChunkSize: 50 });
      const hasContent = chunks.some(c => c.text.includes('X'));
      expect(hasContent).toBe(true);
    });
  });

  // ==========================================================================
  // Empty input
  // ==========================================================================

  describe('empty input', () => {
    it('returns empty array for empty string', () => {
      expect(chunkMarkdown('')).toEqual([]);
    });

    it('returns empty array for whitespace-only input', () => {
      expect(chunkMarkdown('   \n\n  ')).toEqual([]);
    });
  });

  // ==========================================================================
  // No headers (paragraph fallback)
  // ==========================================================================

  describe('no headers', () => {
    it('returns whole text as single preamble chunk', () => {
      const text = 'Just some plain text without any headers.\n\nAnother paragraph.';
      const chunks = chunkMarkdown(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].headingLevel).toBe(0);
      expect(chunks[0].heading).toBe('');
      expect(chunks[0].text).toContain('Just some plain text');
    });

    it('sub-splits headerless text by paragraphs when oversized', () => {
      const paras = Array.from({ length: 10 }, (_, i) =>
        `Paragraph ${i}: ${'word '.repeat(50)}`
      ).join('\n\n');
      const chunks = chunkMarkdown(paras, { maxChunkSize: 300 });
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.headingLevel).toBe(0);
      }
    });
  });

  // ==========================================================================
  // Consecutive headers with no body
  // ==========================================================================

  describe('consecutive headers', () => {
    it('handles headers with no body between them', () => {
      const text = '# A\n# B\n# C\n\nOnly C has content.';
      const chunks = chunkMarkdown(text);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const hasContent = chunks.some(c => c.text.includes('Only C has content.'));
      expect(hasContent).toBe(true);
    });

    it('handles header immediately followed by sub-header', () => {
      const text = '# Parent\n## Child\n\nChild content.';
      const chunks = chunkMarkdown(text);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.some(c => c.text.includes('Child content.'))).toBe(true);
    });
  });

  // ==========================================================================
  // Very long paragraphs (sentence splitting)
  // ==========================================================================

  describe('very long paragraphs', () => {
    it('splits by sentences within a single paragraph', () => {
      const sentences = Array.from({ length: 30 }, (_, i) =>
        `This is sentence number ${i + 1} in the paragraph.`
      ).join(' ');
      const text = '# Section\n\n' + sentences;
      const chunks = chunkMarkdown(text, { maxChunkSize: 300 });
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  // ==========================================================================
  // Unicode content
  // ==========================================================================

  describe('unicode content', () => {
    it('handles emoji and CJK characters', () => {
      const text = '# 日本語ヘッダー\n\nこんにちは世界。\n\n# Emoji 🎉\n\nSome 🚀 content.';
      const chunks = chunkMarkdown(text);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].heading).toBe('日本語ヘッダー');
      expect(chunks[1].heading).toBe('Emoji 🎉');
    });

    it('handles multi-byte characters in offset tracking', () => {
      const text = '# Héader\n\nCafé résumé.\n\n# Second\n\nMore.';
      const chunks = chunkMarkdown(text);
      expect(chunks).toHaveLength(2);
      for (const chunk of chunks) {
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.endOffset).toBeLessThanOrEqual(text.length);
        expect(chunk.startOffset).toBeLessThan(chunk.endOffset);
      }
    });
  });

  // ==========================================================================
  // Offset accuracy
  // ==========================================================================

  describe('offset accuracy', () => {
    it('offsets point to correct positions in original text', () => {
      const text = '# First\n\nBody one.\n\n# Second\n\nBody two.';
      const chunks = chunkMarkdown(text);

      for (const chunk of chunks) {
        const slice = text.slice(chunk.startOffset, chunk.endOffset);
        if (chunk.heading === 'First') {
          expect(slice).toContain('# First');
        } else if (chunk.heading === 'Second') {
          expect(slice).toContain('# Second');
        }
      }
    });

    it('non-overlapping offsets cover the full text for simple cases', () => {
      const text = '# A\n\nOne.\n\n# B\n\nTwo.';
      const chunks = chunkMarkdown(text);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[chunks.length - 1].endOffset).toBe(text.length);
    });

    it('offsets are within bounds for sub-split chunks', () => {
      const text = '# Big\n\n' + Array.from({ length: 20 }, (_, i) =>
        `Paragraph ${i}: ${'word '.repeat(30)}`
      ).join('\n\n');
      const chunks = chunkMarkdown(text, { maxChunkSize: 300 });

      for (const chunk of chunks) {
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.endOffset).toBeLessThanOrEqual(text.length);
      }
    });

    it('sub-split chunk offsets point to matching content in original text', () => {
      const text = '# Big\n\npara1 short.\n\npara2 short.\n\npara3 short.';
      const chunks = chunkMarkdown(text, { maxChunkSize: 30 });
      for (const chunk of chunks) {
        const slice = text.slice(chunk.startOffset, chunk.endOffset);
        // The body portion of the chunk text should be findable in the slice
        const bodyPortion = chunk.text.replace(/^#+ .*\n\n/, '');
        if (bodyPortion.trim()) {
          expect(slice).toContain(bodyPortion.trim().substring(0, 10));
        }
      }
    });

    it('trimEnd does not cause offset/body length mismatch', () => {
      const text = '# A\n\nBody\n\n';
      const chunks = chunkMarkdown(text);
      for (const chunk of chunks) {
        // Body text length should match the offset span
        expect(chunk.text.length).toBe(chunk.endOffset - chunk.startOffset);
      }
    });
  });

  // ==========================================================================
  // Fenced code blocks
  // ==========================================================================

  describe('fenced code blocks', () => {
    it('ignores ATX-looking lines inside fenced code blocks', () => {
      const text = '# Real\n\n```ts\n# not a header\nconst x = 1;\n```\n\n## Child\n\ntext';
      const chunks = chunkMarkdown(text);
      const headings = chunks.map(c => c.heading);
      expect(headings).not.toContain('not a header');
    });

    it('handles tilde-fenced code blocks', () => {
      const text = '# Title\n\n~~~\n# comment\n~~~\n\nAfter.';
      const chunks = chunkMarkdown(text);
      const headings = chunks.map(c => c.heading);
      expect(headings).not.toContain('comment');
    });

    it('handles code block with language specifier', () => {
      const text = '# Title\n\n```python\n# Python comment\ndef foo():\n    pass\n```\n\nDone.';
      const chunks = chunkMarkdown(text);
      expect(chunks.map(c => c.heading)).not.toContain('Python comment');
    });
  });

  // ==========================================================================
  // CRLF handling
  // ==========================================================================

  describe('CRLF handling', () => {
    it('normalizes CRLF line endings', () => {
      const text = '# Header\r\n\r\nBody text.\r\n';
      const chunks = chunkMarkdown(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].heading).toBe('Header');
      expect(chunks[0].text).not.toContain('\r');
    });

    it('normalizes bare CR line endings', () => {
      const text = '# Header\r\rBody text.\r';
      const chunks = chunkMarkdown(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].heading).toBe('Header');
    });
  });

  // ==========================================================================
  // Chunk structure
  // ==========================================================================

  describe('chunk structure', () => {
    it('all required fields are present', () => {
      const text = 'Preamble.\n\n# Header\n\nBody.';
      const chunks = chunkMarkdown(text);
      for (const chunk of chunks) {
        expect(chunk).toHaveProperty('text');
        expect(chunk).toHaveProperty('headingLevel');
        expect(chunk).toHaveProperty('heading');
        expect(chunk).toHaveProperty('index');
        expect(chunk).toHaveProperty('startOffset');
        expect(chunk).toHaveProperty('endOffset');
        expect(typeof chunk.text).toBe('string');
        expect(typeof chunk.headingLevel).toBe('number');
        expect(typeof chunk.heading).toBe('string');
        expect(typeof chunk.index).toBe('number');
        expect(typeof chunk.startOffset).toBe('number');
        expect(typeof chunk.endOffset).toBe('number');
      }
    });
  });
});
