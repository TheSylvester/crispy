import { describe, it, expect } from 'vitest';
import { getSessionDisplayName, getSessionSubtitle } from '../src/webview/utils/session-display.js';
import { getSessionDisplayName as commandsGetSessionDisplayName } from '../src/core/message-view/commands.js';

describe('getSessionDisplayName', () => {
  const base = {
    sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
    customTitle: undefined as string | undefined,
    aiTitle: undefined as string | undefined,
    title: undefined as string | undefined,
    label: undefined as string | undefined,
    lastUserPrompt: undefined as string | undefined,
  };

  it('prefers customTitle over everything', () => {
    expect(getSessionDisplayName({
      ...base,
      customTitle: 'Renamed',
      title: 'Rosie Title',
      aiTitle: 'AI Title',
      lastUserPrompt: 'Last prompt',
      label: 'First prompt',
    })).toBe('Renamed');
  });

  it('prefers title over aiTitle, lastUserPrompt, label', () => {
    expect(getSessionDisplayName({
      ...base,
      title: 'Rosie Title',
      aiTitle: 'AI Title',
      lastUserPrompt: 'Last prompt',
      label: 'First prompt',
    })).toBe('Rosie Title');
  });

  it('prefers aiTitle over lastUserPrompt and label', () => {
    expect(getSessionDisplayName({
      ...base,
      aiTitle: 'AI Title',
      lastUserPrompt: 'Last prompt',
      label: 'First prompt',
    })).toBe('AI Title');
  });

  it('prefers lastUserPrompt over label (legacy behavior preserved)', () => {
    expect(getSessionDisplayName({
      ...base,
      lastUserPrompt: 'Last prompt',
      label: 'First prompt',
    })).toBe('Last prompt');
  });

  it('falls back to label when higher tiers are missing', () => {
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
      customTitle: '',
      title: '',
      label: 'Fallback label',
    })).toBe('Fallback label');
  });

  it('skips whitespace-only strings in the priority chain', () => {
    expect(getSessionDisplayName({
      ...base,
      title: '   ',
      label: 'Fallback label',
    })).toBe('Fallback label');
  });

  it('skips whitespace-only strings and falls to ID', () => {
    expect(getSessionDisplayName({
      ...base,
      title: '   ',
      label: '  ',
    })).toBe('abcdef12\u2026');
  });
});

describe('getSessionSubtitle', () => {
  const base = {
    customTitle: undefined as string | undefined,
    aiTitle: undefined as string | undefined,
    title: undefined as string | undefined,
    label: undefined as string | undefined,
    lastUserPrompt: undefined as string | undefined,
    lastMessage: undefined as string | undefined,
  };

  it('when customTitle is on line 1, picks first distinct from [title, aiTitle, lastUser, label, lastMsg]', () => {
    expect(getSessionSubtitle({
      ...base,
      customTitle: 'Renamed',
      title: 'Rosie Title',
    })).toBe('Rosie Title');
  });

  it('when customTitle is on line 1 and title is also present but identical, falls through to aiTitle', () => {
    expect(getSessionSubtitle({
      ...base,
      customTitle: 'Same',
      title: 'Same',
      aiTitle: 'AI Title',
    })).toBe('AI Title');
  });

  it('when title wins line 1, subtitle picks lastUser over label', () => {
    expect(getSessionSubtitle({
      ...base,
      title: 'Rosie Title',
      lastUserPrompt: 'Last prompt',
      label: 'First prompt',
    })).toBe('Last prompt');
  });

  it('when lastUser wins line 1, subtitle picks label', () => {
    expect(getSessionSubtitle({
      ...base,
      lastUserPrompt: 'Last prompt',
      label: 'First prompt',
    })).toBe('First prompt');
  });

  it('returns null when all fields are identical (no distinct subtitle)', () => {
    expect(getSessionSubtitle({
      ...base,
      customTitle: 'Same',
      title: 'Same',
      aiTitle: 'Same',
      lastUserPrompt: 'Same',
      label: 'Same',
      lastMessage: 'Same',
    })).toBeNull();
  });

  it('returns null when no fields are set', () => {
    expect(getSessionSubtitle(base)).toBeNull();
  });

  it('falls back to lastMessage when label is the only distinct candidate winning line 1', () => {
    expect(getSessionSubtitle({
      ...base,
      label: 'First prompt',
      lastMessage: 'Assistant reply',
    })).toBe('Assistant reply');
  });

  it('never duplicates the line 1 value (aiTitle winner case)', () => {
    expect(getSessionSubtitle({
      ...base,
      aiTitle: 'AI Title',
      title: undefined,
      lastUserPrompt: 'AI Title',
    })).toBeNull();
  });
});

describe('commands.ts getSessionDisplayName parity', () => {
  // Same input table across both implementations.
  const cases = [
    { input: { sessionId: 'a1b2c3d4-ffff', customTitle: 'Renamed', title: 'Rosie', aiTitle: 'AI', lastUserPrompt: 'Last', label: 'First' }, expected: 'Renamed' },
    { input: { sessionId: 'a1b2c3d4-ffff', title: 'Rosie', aiTitle: 'AI', lastUserPrompt: 'Last', label: 'First' }, expected: 'Rosie' },
    { input: { sessionId: 'a1b2c3d4-ffff', aiTitle: 'AI', lastUserPrompt: 'Last', label: 'First' }, expected: 'AI' },
    { input: { sessionId: 'a1b2c3d4-ffff', lastUserPrompt: 'Last', label: 'First' }, expected: 'Last' },
    { input: { sessionId: 'a1b2c3d4-ffff', label: 'First' }, expected: 'First' },
    { input: { sessionId: 'a1b2c3d4-ffff' }, expected: 'a1b2c3d4\u2026' },
  ];

  for (const { input, expected } of cases) {
    it(`both implementations return "${expected}" for the same input`, () => {
      expect(getSessionDisplayName(input)).toBe(expected);
      expect(commandsGetSessionDisplayName(input)).toBe(expected);
    });
  }
});
