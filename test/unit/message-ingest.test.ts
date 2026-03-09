import { describe, it, expect } from 'vitest';
import { extractEntryText } from '../../src/core/recall/message-ingest.js';
import type { TranscriptEntry } from '../../src/core/transcript.js';

// ============================================================================
// extractEntryText
// ============================================================================

describe('extractEntryText', () => {
  it('returns trimmed string content', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { role: 'user', content: '  Hello world  ' },
    };
    expect(extractEntryText(entry)).toBe('Hello world');
  });

  it('joins array content text blocks with double newline', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First block' },
          { type: 'text', text: 'Second block' },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('First block\n\nSecond block');
  });

  it('filters out non-text blocks from array content', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'Visible text' },
          { type: 'thinking', thinking: 'internal reasoning' },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('Visible text');
  });

  it('returns empty string for entry without message', () => {
    const entry: TranscriptEntry = { type: 'user' };
    expect(extractEntryText(entry)).toBe('');
  });

  it('returns empty string for empty string content', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { role: 'user', content: '' },
    };
    expect(extractEntryText(entry)).toBe('');
  });

  it('returns empty string for whitespace-only content', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { role: 'user', content: '   \n  \t  ' },
    };
    expect(extractEntryText(entry)).toBe('');
  });

  it('returns empty string for array content with only non-text blocks', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('');
  });

  it('handles message with undefined content gracefully', () => {
    const entry: TranscriptEntry = {
      type: 'user',
      message: { role: 'user' } as TranscriptEntry['message'],
    };
    expect(extractEntryText(entry)).toBe('');
  });

  it('trims whitespace from individual text blocks', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '  padded  ' },
          { type: 'text', text: '\n\ntrimmed\n\n' },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('padded\n\ntrimmed');
  });

  it('skips text blocks with empty text after trim', () => {
    const entry: TranscriptEntry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '   ' },
          { type: 'text', text: 'Real text' },
          { type: 'text', text: '' },
        ],
      },
    };
    expect(extractEntryText(entry)).toBe('Real text');
  });
});
