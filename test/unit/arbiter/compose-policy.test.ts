import { describe, it, expect } from 'vitest';
import { composePolicies } from '../../../src/core/arbiter/compose-policy.js';
import type { ArbiterPolicy } from '../../../src/core/arbiter/types.js';

function policy(overrides: Partial<ArbiterPolicy> = {}): ArbiterPolicy {
  return {
    deny: [],
    allow: [],
    fallback: 'deny',
    ...overrides,
  };
}

describe('composePolicies', () => {
  it('unions deny rules from base and override', () => {
    const base = policy({ deny: ['Bash(rm *)'] });
    const override = policy({ deny: ['Write(*.env*)'] });
    const result = composePolicies(base, override);
    expect(result.deny).toEqual(['Bash(rm *)', 'Write(*.env*)']);
  });

  it('override allow rules go before base allow rules', () => {
    const base = policy({ allow: ['Read(*)'] });
    const override = policy({ allow: ['Write(src/**)'] });
    const result = composePolicies(base, override);
    expect(result.allow).toEqual(['Write(src/**)', 'Read(*)']);
  });

  it('override fallback replaces base fallback', () => {
    const base = policy({ fallback: 'deny' });
    const override = policy({ fallback: 'escalate' });
    const result = composePolicies(base, override);
    expect(result.fallback).toBe('escalate');
  });

  it('override evaluator replaces base evaluator', () => {
    const base = policy({
      fallback: 'evaluate',
      evaluator: { prompt: 'base agent' },
    });
    const override = policy({
      evaluator: { prompt: 'override agent', model: 'sonnet' },
    });
    const result = composePolicies(base, override);
    expect(result.evaluator).toEqual({ prompt: 'override agent', model: 'sonnet' });
  });

  it('base evaluator preserved when override has none', () => {
    const base = policy({
      fallback: 'evaluate',
      evaluator: { prompt: 'base agent' },
    });
    const override = policy({});
    const result = composePolicies(base, override);
    expect(result.evaluator).toEqual({ prompt: 'base agent' });
  });

  it('override bashMode replaces base bashMode', () => {
    const base = policy({ bashMode: 'strict' });
    const override = policy({ bashMode: 'permissive' });
    const result = composePolicies(base, override);
    expect(result.bashMode).toBe('permissive');
  });

  it('base bashMode preserved when override has none', () => {
    const base = policy({ bashMode: 'strict' });
    const override = policy({});
    const result = composePolicies(base, override);
    expect(result.bashMode).toBe('strict');
  });

  it('override can never remove a base deny rule', () => {
    const base = policy({ deny: ['Bash(rm *)'] });
    const override = policy({ deny: [] });
    const result = composePolicies(base, override);
    expect(result.deny).toContain('Bash(rm *)');
  });

  it('composes complex policies correctly', () => {
    const base = policy({
      deny: ['Bash(rm *)', 'Write(*.env*)'],
      allow: ['Read(*)', 'Bash(git *)'],
      fallback: 'deny',
      bashMode: 'strict',
    });
    const override = policy({
      deny: ['Agent'],
      allow: ['Bash(npm *)'],
      fallback: 'escalate',
      bashMode: 'permissive',
    });
    const result = composePolicies(base, override);
    expect(result.deny).toEqual(['Bash(rm *)', 'Write(*.env*)', 'Agent']);
    expect(result.allow).toEqual(['Bash(npm *)', 'Read(*)', 'Bash(git *)']);
    expect(result.fallback).toBe('escalate');
    expect(result.bashMode).toBe('permissive');
  });
});
