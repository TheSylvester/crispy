/**
 * Tests for resolveCliDefaultModel — the effective-model resolver used by the
 * thinking capability gate when opts.model is empty (e.g. user picked
 * "Default" in the model picker).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveCliDefaultModel } from '../src/core/adapters/claude/claude-code-adapter.js';

describe('resolveCliDefaultModel', () => {
  let originalAnthropicModel: string | undefined;

  beforeEach(() => {
    originalAnthropicModel = process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    if (originalAnthropicModel === undefined) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = originalAnthropicModel;
    }
  });

  it('prefers session env when set', () => {
    expect(resolveCliDefaultModel({ ANTHROPIC_MODEL: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5');
  });

  it('falls back to process env when session env is missing', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    expect(resolveCliDefaultModel({})).toBe('claude-sonnet-4-6');
  });

  it('falls back to the hardcoded CLI default when neither env var is set', () => {
    expect(resolveCliDefaultModel({})).toBe('claude-opus-4-7');
  });

  it('session env wins over process env', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    expect(resolveCliDefaultModel({ ANTHROPIC_MODEL: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5');
  });

  it('treats empty session env as unset and falls through to process env', () => {
    // Mirrors `||` short-circuit: empty string is falsy.
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    expect(resolveCliDefaultModel({ ANTHROPIC_MODEL: '' })).toBe('claude-sonnet-4-6');
  });
});
