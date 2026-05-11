import { describe, it, expect } from 'vitest';
import { getSessionDisplayName, getSessionSubtitle } from '../src/webview/utils/session-display.js';
import { getSessionDisplayName as commandsGetSessionDisplayName } from '../src/core/message-view/commands.js';
import { getSessionDisplayName as coreGetSessionDisplayName } from '../src/core/session-display-name.js';

// 5-tier cascade: customTitle → aiTitle → lastUserPrompt → label → ID.
// Tests below pin the order so future drift surfaces immediately.

describe('getSessionDisplayName', () => {
  const base = {
    sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
    customTitle: undefined as string | undefined,
    aiTitle: undefined as string | undefined,
    label: undefined as string | undefined,
    lastUserPrompt: undefined as string | undefined,
  };

  it('prefers customTitle over everything', () => {
    expect(getSessionDisplayName({
      ...base,
      customTitle: 'Renamed',
      aiTitle: 'AI Title',
      lastUserPrompt: 'Last prompt',
      label: 'First prompt',
    })).toBe('Renamed');
  });

  it('prefers aiTitle over lastUserPrompt and label', () => {
    expect(getSessionDisplayName({
      ...base,
      aiTitle: 'AI Title',
      lastUserPrompt: 'Last prompt',
      label: 'First prompt',
    })).toBe('AI Title');
  });

  it('prefers lastUserPrompt over label', () => {
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
    expect(getSessionDisplayName(base)).toBe('abcdef12…');
  });

  it('skips empty strings in the priority chain', () => {
    expect(getSessionDisplayName({
      ...base,
      customTitle: '',
      aiTitle: '',
      label: 'Fallback label',
    })).toBe('Fallback label');
  });

  it('skips whitespace-only strings in the priority chain', () => {
    expect(getSessionDisplayName({
      ...base,
      aiTitle: '   ',
      label: 'Fallback label',
    })).toBe('Fallback label');
  });

  it('skips whitespace-only strings and falls to ID', () => {
    expect(getSessionDisplayName({
      ...base,
      aiTitle: '   ',
      label: '  ',
    })).toBe('abcdef12…');
  });
});

describe('getSessionSubtitle', () => {
  const base = {
    customTitle: undefined as string | undefined,
    aiTitle: undefined as string | undefined,
    label: undefined as string | undefined,
    lastUserPrompt: undefined as string | undefined,
    lastMessage: undefined as string | undefined,
  };

  it('when customTitle is on line 1, picks first distinct from [aiTitle, lastUser, label, lastMsg]', () => {
    expect(getSessionSubtitle({
      ...base,
      customTitle: 'Renamed',
      aiTitle: 'AI Title',
    })).toBe('AI Title');
  });

  it('when customTitle and aiTitle are identical, falls through to lastUserPrompt', () => {
    expect(getSessionSubtitle({
      ...base,
      customTitle: 'Same',
      aiTitle: 'Same',
      lastUserPrompt: 'Last prompt',
    })).toBe('Last prompt');
  });

  it('when aiTitle wins line 1, subtitle picks lastUser over label', () => {
    expect(getSessionSubtitle({
      ...base,
      aiTitle: 'AI Title',
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
      aiTitle: 'Same',
      lastUserPrompt: 'Same',
      label: 'Same',
      lastMessage: 'Same',
    })).toBeNull();
  });

  it('returns null when no fields are set', () => {
    expect(getSessionSubtitle(base)).toBeNull();
  });

  it('falls back to lastMessage when label wins line 1', () => {
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
      lastUserPrompt: 'AI Title',
    })).toBeNull();
  });
});

describe('cross-implementation parity (webview / commands / core util)', () => {
  // Single source of truth for the cascade — same input table across
  // every cascade resolver. If any drift, the table catches it.
  const cases = [
    { input: { sessionId: 'a1b2c3d4-ffff', customTitle: 'Renamed', aiTitle: 'AI', lastUserPrompt: 'Last', label: 'First' }, expected: 'Renamed' },
    { input: { sessionId: 'a1b2c3d4-ffff', aiTitle: 'AI', lastUserPrompt: 'Last', label: 'First' }, expected: 'AI' },
    { input: { sessionId: 'a1b2c3d4-ffff', lastUserPrompt: 'Last', label: 'First' }, expected: 'Last' },
    { input: { sessionId: 'a1b2c3d4-ffff', label: 'First' }, expected: 'First' },
    { input: { sessionId: 'a1b2c3d4-ffff' }, expected: 'a1b2c3d4…' },
  ];

  for (const { input, expected } of cases) {
    it(`every implementation returns "${expected}" for the same input`, () => {
      expect(getSessionDisplayName(input)).toBe(expected);
      expect(commandsGetSessionDisplayName(input)).toBe(expected);
      expect(coreGetSessionDisplayName(input)).toBe(expected);
    });
  }
});
