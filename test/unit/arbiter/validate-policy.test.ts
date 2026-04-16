import { describe, it, expect } from 'vitest';
import { validatePolicy } from '../../../src/core/arbiter/validate-policy.js';
import type { ArbiterPolicy } from '../../../src/core/arbiter/types.js';

function policy(overrides: Partial<ArbiterPolicy> = {}): ArbiterPolicy {
  return {
    deny: [],
    allow: [],
    fallback: 'deny',
    ...overrides,
  };
}

describe('validatePolicy', () => {
  it('accepts a valid policy', () => {
    const result = validatePolicy(
      policy({
        deny: ['Bash(rm *)'],
        allow: ['Read(*)', 'Bash(git *)'],
        fallback: 'escalate',
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects evaluate fallback without evaluator', () => {
    const result = validatePolicy(policy({ fallback: 'evaluate' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('evaluate');
    expect(result.errors[0]).toContain('evaluator');
  });

  it('accepts evaluate fallback with evaluator', () => {
    const result = validatePolicy(
      policy({
        fallback: 'evaluate',
        evaluator: { prompt: 'test agent' },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('warns on unknown tool names', () => {
    const result = validatePolicy(policy({ deny: ['UnknownTool(*)'] }));
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('UnknownTool');
  });

  it('does not warn on known tool names', () => {
    const result = validatePolicy(
      policy({
        deny: ['Bash(rm *)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'],
        allow: ['WebFetch(*)', 'Agent'],
      }),
    );
    expect(result.warnings).toEqual([]);
  });

  it('errors on malformed patterns', () => {
    const result = validatePolicy(policy({ deny: [''] }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Malformed pattern');
  });

  it('reports errors from both deny and allow lists', () => {
    const result = validatePolicy(policy({ deny: [''], allow: [''] }));
    expect(result.errors).toHaveLength(2);
  });

  it('accepts empty deny + empty allow + fallback deny (deny-all sandbox)', () => {
    const result = validatePolicy(policy({ fallback: 'deny' }));
    expect(result.valid).toBe(true);
  });

  it('accepts empty deny + empty allow + fallback escalate (pass-through)', () => {
    const result = validatePolicy(policy({ fallback: 'escalate' }));
    expect(result.valid).toBe(true);
  });

  it('collects multiple errors and warnings', () => {
    const result = validatePolicy(
      policy({
        deny: ['', 'CustomMcpTool(*)'],
        allow: ['Bash()'],
        fallback: 'evaluate',
      }),
    );
    expect(result.valid).toBe(false);
    // 1 malformed deny, 1 malformed allow, 1 missing evaluator
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    // 1 unknown tool warning
    expect(result.warnings).toHaveLength(1);
  });
});
