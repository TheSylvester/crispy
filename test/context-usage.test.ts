/**
 * Tests for computeContextFromEntries — the historical fallback that derives
 * context gauge data from transcript entries when the adapter hasn't sent
 * live contextUsage yet (e.g. forked sessions before the first turn).
 */

import { describe, it, expect } from 'vitest';
import { computeContextFromEntries } from '../src/webview/hooks/useContextUsage.js';
import type { TranscriptEntry } from '../src/core/transcript.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal assistant entry with usage data. */
function assistant(
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
  vendor: string = 'claude',
): TranscriptEntry {
  return {
    type: 'assistant',
    vendor,
    message: {
      role: 'assistant',
      content: 'hello',
      model,
      usage,
    },
  };
}

/** Minimal result entry with modelUsage metadata. */
function result(contextWindow?: number): TranscriptEntry {
  const metadata: Record<string, unknown> = {};
  if (contextWindow !== undefined) {
    metadata.modelUsage = {
      'claude-opus-4-6': { contextWindow },
    };
  }
  return {
    type: 'result',
    vendor: 'claude',
    ...(Object.keys(metadata).length > 0 && { metadata }),
  };
}

/** User prompt entry (filler). */
function user(text: string = 'hi'): TranscriptEntry {
  return {
    type: 'user',
    vendor: 'claude',
    message: { role: 'user', content: text },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeContextFromEntries', () => {
  it('returns null for empty entries', () => {
    expect(computeContextFromEntries([])).toBeNull();
  });

  it('returns null when no assistant entry has usage', () => {
    const entries: TranscriptEntry[] = [
      user(),
      { type: 'assistant', vendor: 'claude', message: { role: 'assistant', content: 'hi' } },
    ];
    expect(computeContextFromEntries(entries)).toBeNull();
  });

  it('uses modelUsage.contextWindow from result entry (priority 1)', () => {
    const entries = [
      user(),
      assistant('claude-opus-4-6', { input_tokens: 50_000, output_tokens: 1_000 }),
      result(1_000_000),
    ];
    const ctx = computeContextFromEntries(entries);
    expect(ctx).not.toBeNull();
    expect(ctx!.contextWindow).toBe(1_000_000);
    expect(ctx!.totalTokens).toBe(51_000);
    expect(ctx!.percent).toBe(5); // 51k / 1M = 5.1% → rounded to 5
  });

  it('falls back to model name lookup when result has no modelUsage (priority 2 — the fork bug)', () => {
    // This is the exact scenario: forked session, result entry has empty
    // modelUsage or no modelUsage at all. Should use the model string from
    // the assistant message to look up the context window.
    const entries = [
      user(),
      assistant('claude-opus-4-6', {
        input_tokens: 70_000,
        output_tokens: 500,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 8_000,
      }),
      result(), // no modelUsage
    ];
    const ctx = computeContextFromEntries(entries);
    expect(ctx).not.toBeNull();
    expect(ctx!.contextWindow).toBe(1_000_000); // Opus = 1M, NOT 200k
    expect(ctx!.totalTokens).toBe(80_500);
  });

  it('falls back to model name lookup when result has empty modelUsage', () => {
    const entries = [
      user(),
      assistant('claude-opus-4-6', { input_tokens: 80_000, output_tokens: 1_307 }),
      { type: 'result' as const, vendor: 'claude', metadata: { modelUsage: {} } },
    ];
    const ctx = computeContextFromEntries(entries);
    expect(ctx).not.toBeNull();
    expect(ctx!.contextWindow).toBe(1_000_000);
  });

  it('returns 200k for sonnet model (no result entry)', () => {
    const entries = [
      user(),
      assistant('claude-sonnet-4-6', { input_tokens: 50_000, output_tokens: 500 }),
    ];
    const ctx = computeContextFromEntries(entries);
    expect(ctx).not.toBeNull();
    expect(ctx!.contextWindow).toBe(200_000);
  });

  it('returns 200k default when no model info at all', () => {
    // Assistant entry with usage but no model string, no result entry
    const entries: TranscriptEntry[] = [
      user(),
      {
        type: 'assistant',
        vendor: 'claude',
        message: {
          role: 'assistant',
          content: 'hi',
          usage: { input_tokens: 10_000, output_tokens: 500 },
        },
      },
    ];
    const ctx = computeContextFromEntries(entries);
    expect(ctx).not.toBeNull();
    expect(ctx!.contextWindow).toBe(200_000);
  });

  it('respects vendor field for cross-vendor entries', () => {
    const entries = [
      user(),
      assistant('', { input_tokens: 30_000, output_tokens: 500 }, 'gemini'),
    ];
    const ctx = computeContextFromEntries(entries);
    expect(ctx).not.toBeNull();
    // Gemini default = 1M
    expect(ctx!.contextWindow).toBe(1_000_000);
  });

  it('uses most recent assistant entry (backwards scan)', () => {
    const entries = [
      user(),
      assistant('claude-sonnet-4-6', { input_tokens: 10_000, output_tokens: 100 }),
      user(),
      assistant('claude-opus-4-6', { input_tokens: 80_000, output_tokens: 1_000 }),
    ];
    const ctx = computeContextFromEntries(entries);
    expect(ctx).not.toBeNull();
    // Should use the last assistant's usage (opus)
    expect(ctx!.totalTokens).toBe(81_000);
    expect(ctx!.contextWindow).toBe(1_000_000);
  });

  it('caps percent at 100', () => {
    const entries = [
      user(),
      assistant('claude-sonnet-4-6', { input_tokens: 190_000, output_tokens: 15_000 }),
    ];
    const ctx = computeContextFromEntries(entries);
    expect(ctx).not.toBeNull();
    expect(ctx!.percent).toBe(100);
  });
});
