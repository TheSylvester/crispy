/**
 * Tests for thinking capability helpers — normalizeModelString,
 * modelSupportsAdaptiveThinking, and buildThinkingConfig.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeModelString,
  modelSupportsAdaptiveThinking,
  buildThinkingConfig,
  type ClaudeSessionOptions,
} from '../src/core/adapters/claude/claude-code-adapter.js';

const baseOpts = (partial: Partial<ClaudeSessionOptions>): ClaudeSessionOptions => ({
  cwd: '/tmp',
  ...partial,
});

describe('normalizeModelString', () => {
  it('strips -YYYYMMDD date suffix', () => {
    expect(normalizeModelString('claude-opus-4-7-20260416')).toBe('claude-opus-4-7');
  });

  it('strips -YYYY-MM-DD date suffix', () => {
    expect(normalizeModelString('claude-opus-4-7-2026-04-16')).toBe('claude-opus-4-7');
  });

  it('leaves undated strings alone', () => {
    expect(normalizeModelString('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(normalizeModelString('opus')).toBe('opus');
  });

  it('does not strip speculative suffixes', () => {
    expect(normalizeModelString('claude-opus-4-7-preview')).toBe('claude-opus-4-7-preview');
  });

  it('strips [1m] context-window suffix', () => {
    expect(normalizeModelString('claude-opus-4-7[1m]')).toBe('claude-opus-4-7');
    expect(normalizeModelString('opus[1m]')).toBe('opus');
  });

  it('strips bracket variant followed by date suffix', () => {
    expect(normalizeModelString('claude-opus-4-7[1m]')).toBe('claude-opus-4-7');
  });
});

describe('modelSupportsAdaptiveThinking', () => {
  it.each([
    ['claude-opus-4-7'],
    ['claude-opus-4-6'],
    ['opus'],
    ['claude-opus-4-7-20260416'],   // date suffix -YYYYMMDD
    ['claude-opus-4-7-2026-04-16'], // date suffix -YYYY-MM-DD
    ['claude-opus-4-7[1m]'],        // 1M-context variant
    ['opus[1m]'],
  ])('accepts %s', (m) => {
    expect(modelSupportsAdaptiveThinking(m)).toBe(true);
  });

  it.each([
    ['claude-opus-4-5'],    // below Opus 4.6+ floor per SDK docs
    ['sonnet'],
    ['haiku'],
    ['claude-sonnet-4-6'],
    ['claude-haiku-4-5'],
    [''],
    ['claude-opus-3'],
    ['claude-opus-4-7-preview'],    // speculative suffix — not whitelisted
    ['claude-opus-4-7@2026-04-16'], // alternate speculative form
    ['claude-opus-4-8'],            // future model — add to table when confirmed
  ])('rejects %s', (m) => {
    expect(modelSupportsAdaptiveThinking(m)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(modelSupportsAdaptiveThinking(undefined)).toBe(false);
  });
});

describe('buildThinkingConfig', () => {
  it('Opus + supportsDisplay: true + default → summarized', () => {
    const r = buildThinkingConfig(baseOpts({ model: 'claude-opus-4-7' }), { supportsDisplay: true });
    expect(r).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('Opus + supportsDisplay: true + thinkingDisplay=omitted → omitted', () => {
    const r = buildThinkingConfig(
      baseOpts({ model: 'claude-opus-4-7', thinkingDisplay: 'omitted' }),
      { supportsDisplay: true },
    );
    expect(r).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('Opus + supportsDisplay: false → no display field (CLI too old)', () => {
    const r = buildThinkingConfig(
      baseOpts({ model: 'claude-opus-4-7' }),
      { supportsDisplay: false },
    );
    expect(r).toEqual({ type: 'adaptive' });
  });

  it('handles "opus" short alias', () => {
    const r = buildThinkingConfig(baseOpts({ model: 'opus' }), { supportsDisplay: true });
    expect(r).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('handles dated Opus model strings', () => {
    const r = buildThinkingConfig(
      baseOpts({ model: 'claude-opus-4-7-20260416' }),
      { supportsDisplay: true },
    );
    expect(r).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('returns undefined for Sonnet', () => {
    expect(
      buildThinkingConfig(baseOpts({ model: 'claude-sonnet-4-6' }), { supportsDisplay: true }),
    ).toBeUndefined();
  });

  it('returns undefined for Haiku', () => {
    expect(
      buildThinkingConfig(baseOpts({ model: 'haiku' }), { supportsDisplay: true }),
    ).toBeUndefined();
  });

  it('returns undefined for unknown model', () => {
    expect(
      buildThinkingConfig(baseOpts({ model: 'some-custom-model' }), { supportsDisplay: true }),
    ).toBeUndefined();
  });

  it('returns undefined when model is blank / missing', () => {
    expect(
      buildThinkingConfig(baseOpts({ model: '' }), { supportsDisplay: true }),
    ).toBeUndefined();
    expect(
      buildThinkingConfig(baseOpts({}), { supportsDisplay: true }),
    ).toBeUndefined();
  });

  it('returns undefined for Opus when outputFormat is set (structured fork)', () => {
    const r = buildThinkingConfig(
      baseOpts({
        model: 'claude-opus-4-7',
        outputFormat: { type: 'json_schema', schema: {} },
      }),
      { supportsDisplay: true },
    );
    expect(r).toBeUndefined();
  });
});
