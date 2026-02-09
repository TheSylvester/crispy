/**
 * Tests for normalizeToBlocks — projects every entry shape into ContentBlock[]
 */

import { describe, it, expect } from 'vitest';
import { normalizeToBlocks } from '../src/webview/utils/normalize-blocks.js';
import type { TranscriptEntry, ContentBlock } from '../src/core/transcript.js';

/** Helper to build a minimal TranscriptEntry */
function entry(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return { type: 'assistant', ...overrides };
}

describe('normalizeToBlocks', () => {
  // ── Rule 1: summary entries ──────────────────────────────────────────

  it('converts summary entry to a single text block', () => {
    const result = normalizeToBlocks(entry({
      type: 'summary',
      summary: 'Session started',
    }));
    expect(result).toEqual([{ type: 'text', text: 'Session started' }]);
  });

  it('returns [] for summary entry with no summary text', () => {
    const result = normalizeToBlocks(entry({ type: 'summary' }));
    expect(result).toEqual([]);
  });

  it('returns [] for summary entry with empty summary', () => {
    const result = normalizeToBlocks(entry({ type: 'summary', summary: '' }));
    expect(result).toEqual([]);
  });

  // ── Rule 2: string content ───────────────────────────────────────────

  it('wraps string content in a text block', () => {
    const result = normalizeToBlocks(entry({
      message: { content: 'Hello world' },
    }));
    expect(result).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('returns [] for empty string content', () => {
    const result = normalizeToBlocks(entry({
      message: { content: '' },
    }));
    expect(result).toEqual([]);
  });

  // ── Rule 3: ContentBlock[] passthrough ───────────────────────────────

  it('passes through ContentBlock[] as-is', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    const result = normalizeToBlocks(entry({
      message: { content: blocks },
    }));
    expect(result).toBe(blocks); // Same reference
  });

  it('passes through mixed block types', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'output' },
    ];
    const result = normalizeToBlocks(entry({
      message: { content: blocks },
    }));
    expect(result).toBe(blocks);
    expect(result).toHaveLength(4);
  });

  // ── Rule 4: fallback to [] ───────────────────────────────────────────

  it('returns [] when entry has no message', () => {
    const result = normalizeToBlocks(entry({}));
    expect(result).toEqual([]);
  });

  it('returns [] when message content is undefined', () => {
    const result = normalizeToBlocks(entry({
      message: { content: undefined as unknown as string },
    }));
    expect(result).toEqual([]);
  });

  it('returns [] when message content is null', () => {
    const result = normalizeToBlocks(entry({
      message: { content: null as unknown as string },
    }));
    expect(result).toEqual([]);
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  it('prefers summary path over message content for summary entries', () => {
    const result = normalizeToBlocks(entry({
      type: 'summary',
      summary: 'The summary',
      message: { content: 'Should be ignored' },
    }));
    expect(result).toEqual([{ type: 'text', text: 'The summary' }]);
  });

  it('handles user entries with string content', () => {
    const result = normalizeToBlocks(entry({
      type: 'user',
      message: { role: 'user', content: 'Fix the bug' },
    }));
    expect(result).toEqual([{ type: 'text', text: 'Fix the bug' }]);
  });

  it('handles single-element block arrays', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'only one' }];
    const result = normalizeToBlocks(entry({
      message: { content: blocks },
    }));
    expect(result).toBe(blocks);
    expect(result).toHaveLength(1);
  });

  it('handles empty block arrays', () => {
    const blocks: ContentBlock[] = [];
    const result = normalizeToBlocks(entry({
      message: { content: blocks },
    }));
    expect(result).toBe(blocks);
    expect(result).toHaveLength(0);
  });
});
