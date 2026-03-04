import { describe, it, expect } from 'vitest';
import { getSessionDisplayName } from '../src/webview/utils/session-display.js';

describe('getSessionDisplayName', () => {
  const base = {
    sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
    title: undefined as string | undefined,
    quest: undefined as string | undefined,
    label: undefined as string | undefined,
  };

  it('prefers title over quest and label', () => {
    expect(getSessionDisplayName({
      ...base,
      title: 'My Title',
      quest: 'Build a spaceship',
      label: 'First user message',
    })).toBe('My Title');
  });

  it('falls back to quest when title is missing', () => {
    expect(getSessionDisplayName({
      ...base,
      quest: 'Build a spaceship',
      label: 'First user message',
    })).toBe('Build a spaceship');
  });

  it('falls back to label when quest is also missing', () => {
    expect(getSessionDisplayName({
      ...base,
      label: 'First user message',
    })).toBe('First user message');
  });

  it('falls back to truncated session ID when all fields are missing', () => {
    expect(getSessionDisplayName(base)).toBe('abcdef12\u2026');
  });

  it('skips empty strings in the priority chain', () => {
    expect(getSessionDisplayName({
      ...base,
      title: '',
      quest: '',
      label: 'Fallback label',
    })).toBe('Fallback label');
  });

  it('skips empty title and quest, falls to ID', () => {
    expect(getSessionDisplayName({
      ...base,
      title: '',
      quest: '',
      label: '',
    })).toBe('abcdef12\u2026');
  });

  it('skips whitespace-only strings in the priority chain', () => {
    expect(getSessionDisplayName({
      ...base,
      title: '   ',
      quest: '  \t ',
      label: 'Fallback label',
    })).toBe('Fallback label');
  });

  it('skips whitespace-only strings and falls to ID', () => {
    expect(getSessionDisplayName({
      ...base,
      title: '   ',
      quest: ' ',
      label: '  ',
    })).toBe('abcdef12\u2026');
  });
});
