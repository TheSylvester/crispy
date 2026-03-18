import { describe, expect, it } from 'vitest';
import { getContextWindowTokens } from '../src/core/model-utils.js';

describe('getContextWindowTokens', () => {
  it('maps codex gpt-5.4 to the long context window', () => {
    expect(getContextWindowTokens('codex', 'gpt-5.4')).toBe(1_050_000);
  });

  it('maps codex gpt-5.4 snapshots with OpenAI-style date suffixes', () => {
    expect(getContextWindowTokens('codex', 'gpt-5.4-2026-03-05')).toBe(1_050_000);
    expect(getContextWindowTokens('codex', 'gpt-5.4-pro-2026-03-05')).toBe(1_050_000);
  });

  it('maps current codex gpt-5 family aliases to 400k where applicable', () => {
    expect(getContextWindowTokens('codex', 'gpt-5')).toBe(400_000);
    expect(getContextWindowTokens('codex', 'gpt-5.1-codex')).toBe(400_000);
    expect(getContextWindowTokens('codex', 'gpt-5.2-codex')).toBe(400_000);
  });
});
