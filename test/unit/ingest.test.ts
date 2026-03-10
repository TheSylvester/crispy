import { describe, it, expect } from 'vitest';
import { entriesToText } from '../../src/core/recall/ingest.js';
import { stripToolContent } from '../../src/core/recall/transcript-utils.js';
import type { TranscriptEntry } from '../../src/core/transcript.js';

// ============================================================================
// entriesToText
// ============================================================================

describe('entriesToText', () => {
  it('concatenates string content from user/assistant entries', () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'Hello world' } },
      { type: 'assistant', message: { role: 'assistant', content: 'Hi there' } },
    ];
    const text = entriesToText(entries);
    expect(text).toBe('Hello world\n\nHi there');
  });

  it('concatenates array content text blocks', () => {
    const entries: TranscriptEntry[] = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'First block' },
            { type: 'text', text: 'Second block' },
          ],
        },
      },
    ];
    const text = entriesToText(entries);
    expect(text).toBe('First block\n\nSecond block');
  });

  it('returns empty string for entries with no text', () => {
    const entries: TranscriptEntry[] = [
      { type: 'system', message: { role: 'system', content: '' } },
    ];
    const text = entriesToText(entries);
    expect(text).toBe('');
  });

  it('handles entries without message', () => {
    const entries: TranscriptEntry[] = [
      { type: 'user' },
      { type: 'assistant', message: { role: 'assistant', content: 'Only this' } },
    ];
    const text = entriesToText(entries);
    expect(text).toBe('Only this');
  });

  it('handles mixed string and array content', () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: 'Plain text' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Array text' }],
        },
      },
    ];
    const text = entriesToText(entries);
    expect(text).toBe('Plain text\n\nArray text');
  });

  it('skips non-text blocks in array content', () => {
    const entries: TranscriptEntry[] = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'x', name: 'bash', input: {} },
            { type: 'text', text: 'Visible text' },
          ],
        },
      },
    ];
    const text = entriesToText(entries);
    expect(text).toBe('Visible text');
  });

  it('trims whitespace from blocks', () => {
    const entries: TranscriptEntry[] = [
      { type: 'user', message: { role: 'user', content: '  spaced  ' } },
    ];
    const text = entriesToText(entries);
    expect(text).toBe('spaced');
  });
});

// ============================================================================
// stripToolContent → entriesToText integration
// ============================================================================

describe('stripToolContent + entriesToText pipeline', () => {
  it('strips tool blocks and produces clean text', () => {
    const entries: TranscriptEntry[] = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Please fix the bug' }],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will fix it now.' },
            { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'file1.ts\nfile2.ts' },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal reasoning...' },
            { type: 'text', text: 'Done! The bug is fixed.' },
          ],
        },
      },
    ];

    const stripped = stripToolContent(entries);
    const text = entriesToText(stripped);

    // tool_result entry should be dropped entirely
    // tool_use and thinking blocks should be filtered out
    expect(text).toBe('Please fix the bug\n\nI will fix it now.\n\nDone! The bug is fixed.');
  });

  it('returns empty string when all content is tool blocks', () => {
    const entries: TranscriptEntry[] = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu1', name: 'bash', input: {} },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', content: 'output' },
          ],
        },
      },
    ];

    const stripped = stripToolContent(entries);
    const text = entriesToText(stripped);
    expect(text).toBe('');
  });

  it('handles empty entries array', () => {
    const stripped = stripToolContent([]);
    const text = entriesToText(stripped);
    expect(text).toBe('');
  });
});
