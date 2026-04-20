/**
 * Tests for the capability-band branch of diffNeedsRestart.
 *
 * The SDK freezes thinking config at startQuery time, so flipping between
 * thinking-capable (Opus 4.6+) and non-capable models must tear down the
 * query. Crucially, swapping to "Default" (empty model) that resolves to the
 * same band as the current model must NOT trigger a spurious restart.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ClaudeAgentAdapter,
  type ClaudeSessionOptions,
} from '../src/core/adapters/claude/claude-code-adapter.js';
import type { TurnSettings } from '../src/core/agent-adapter.js';

function make(opts: Partial<ClaudeSessionOptions> = {}): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter({ cwd: '/tmp', ...opts });
}

// Exposed via cast — diffNeedsRestart is private but we're exercising the
// capability-band branch specifically.
function needsRestart(adapter: ClaudeAgentAdapter, settings: TurnSettings): boolean {
  return (adapter as unknown as { diffNeedsRestart(s: TurnSettings): boolean }).diffNeedsRestart(settings);
}

describe('diffNeedsRestart — capability band change', () => {
  const adapters: ClaudeAgentAdapter[] = [];
  let originalAnthropicModel: string | undefined;

  beforeEach(() => {
    originalAnthropicModel = process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    // Adapters create tmpdirs in the constructor; close() cleans them up.
    for (const a of adapters) a.close();
    adapters.length = 0;
    if (originalAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = originalAnthropicModel;
  });

  function track(a: ClaudeAgentAdapter): ClaudeAgentAdapter {
    adapters.push(a);
    return a;
  }

  it('haiku → opus-4-7 triggers restart (non-capable → capable)', () => {
    const a = track(make({ model: 'claude-haiku-4-5' }));
    expect(needsRestart(a, { model: 'claude-opus-4-7' })).toBe(true);
  });

  it('opus-4-6 → opus-4-7 does not trigger restart (same band)', () => {
    const a = track(make({ model: 'claude-opus-4-6' }));
    expect(needsRestart(a, { model: 'claude-opus-4-7' })).toBe(false);
  });

  it('opus-4-7 → sonnet-4-6 triggers restart (capable → non-capable)', () => {
    const a = track(make({ model: 'claude-opus-4-7' }));
    expect(needsRestart(a, { model: 'claude-sonnet-4-6' })).toBe(true);
  });

  it('opus-4-7 → "" (Default) with no ANTHROPIC_MODEL does not trigger restart', () => {
    const a = track(make({ model: 'claude-opus-4-7' }));
    expect(needsRestart(a, { model: '' })).toBe(false);
  });

  it('haiku → "" (Default) with no ANTHROPIC_MODEL triggers restart (resolves to opus-4-7)', () => {
    const a = track(make({ model: 'claude-haiku-4-5' }));
    expect(needsRestart(a, { model: '' })).toBe(true);
  });

  it('opus-4-7[1m] → opus-4-7 does not trigger restart (bracket variant in same band)', () => {
    const a = track(make({ model: 'claude-opus-4-7[1m]' }));
    expect(needsRestart(a, { model: 'claude-opus-4-7' })).toBe(false);
  });

  it('returns false when model setting is unchanged', () => {
    const a = track(make({ model: 'claude-opus-4-7' }));
    expect(needsRestart(a, { model: 'claude-opus-4-7' })).toBe(false);
  });

  it('returns false when model setting is not supplied', () => {
    const a = track(make({ model: 'claude-opus-4-7' }));
    expect(needsRestart(a, {})).toBe(false);
  });
});
