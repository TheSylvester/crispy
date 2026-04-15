import { describe, it, expect } from 'vitest';
import { evaluate, UNSAFE_BASH } from '../../../src/core/arbiter/evaluate.js';
import type { ArbiterPolicy } from '../../../src/core/arbiter/types.js';

/** Helper to build a minimal policy */
function policy(overrides: Partial<ArbiterPolicy> = {}): ArbiterPolicy {
  return {
    deny: [],
    allow: [],
    fallback: 'deny',
    ...overrides,
  };
}

describe('evaluate', () => {
  // ── Deny takes precedence ──────────────────────────────────────
  describe('deny takes precedence', () => {
    it('denies when both deny and allow match', () => {
      const p = policy({
        deny: ['Bash(rm *)'],
        allow: ['Bash(*)'],
      });
      const result = evaluate('Bash', { command: 'rm -rf /' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toContain('deny:');
    });

    it('deny matches before allow even if allow is more specific', () => {
      const p = policy({
        deny: ['Write(*.env*)'],
        allow: ['Write(.env.example)'],
      });
      const result = evaluate('Write', { file_path: '.env.example' }, p);
      expect(result.decision).toBe('deny');
    });
  });

  // ── Allow rule ordering ────────────────────────────────────────
  describe('allow rule ordering', () => {
    it('first matching allow rule wins', () => {
      const p = policy({
        allow: ['Bash(git *)', 'Bash(*)'],
        fallback: 'deny',
      });
      const result = evaluate('Bash', { command: 'git status' }, p);
      expect(result.decision).toBe('allow');
      expect(result.source).toBe('allow:Bash(git *)');
    });

    it('skips non-matching allow rules', () => {
      const p = policy({
        allow: ['Bash(npm *)', 'Bash(git *)'],
        fallback: 'deny',
      });
      const result = evaluate('Bash', { command: 'git status' }, p);
      expect(result.decision).toBe('allow');
      expect(result.source).toBe('allow:Bash(git *)');
    });
  });

  // ── Fallback behavior ──────────────────────────────────────────
  describe('fallback behavior', () => {
    it('falls back to deny when no rules match', () => {
      const p = policy({ fallback: 'deny' });
      const result = evaluate('Bash', { command: 'curl example.com' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('fallback:deny');
    });

    it('falls back to escalate when no rules match', () => {
      const p = policy({ fallback: 'escalate' });
      const result = evaluate('Bash', { command: 'curl example.com' }, p);
      expect(result.decision).toBe('escalate');
      expect(result.source).toBe('fallback:escalate');
    });

    it('falls back to needs-llm when fallback is evaluate', () => {
      const p = policy({
        fallback: 'evaluate',
        evaluator: { prompt: 'test agent' },
      });
      const result = evaluate('Bash', { command: 'curl example.com' }, p);
      expect(result.decision).toBe('escalate');
      expect(result.source).toBe('fallback:needs-llm');
    });
  });

  // ── Bash safety mode ───────────────────────────────────────────
  describe('bash safety mode', () => {
    const metacharacters = [
      { char: ';', cmd: 'echo hello; rm -rf /' },
      { char: '&&', cmd: 'git add && git commit' },
      { char: '||', cmd: 'test -f x || exit 1' },
      { char: '|', cmd: 'cat file | grep foo' },
      { char: '`', cmd: 'echo `whoami`' },
      { char: '$()', cmd: 'echo $(whoami)' },
      { char: '\\n', cmd: 'echo hello\nrm -rf /' },
      { char: '<<', cmd: 'cat << EOF' },
      { char: '<()', cmd: 'diff <(ls) <(ls -a)' },
    ];

    for (const { char, cmd } of metacharacters) {
      it(`strict mode denies shell metacharacter: ${char}`, () => {
        const p = policy({ bashMode: 'strict', allow: ['Bash(*)'] });
        const result = evaluate('Bash', { command: cmd }, p);
        expect(result.decision).toBe('deny');
        expect(result.source).toBe('bashMode:strict');
      });
    }

    it('strict mode allows safe commands through', () => {
      const p = policy({ allow: ['Bash(git *)'], bashMode: 'strict' });
      const result = evaluate('Bash', { command: 'git status' }, p);
      expect(result.decision).toBe('allow');
    });

    it('permissive mode allows shell metacharacters through to user rules', () => {
      const p = policy({
        allow: ['Bash(*)'],
        bashMode: 'permissive',
      });
      const result = evaluate('Bash', { command: 'git add && git commit' }, p);
      expect(result.decision).toBe('allow');
    });

    it('strict mode fires before user allow rules', () => {
      const p = policy({
        allow: ['Bash(git add && git commit)'],
        bashMode: 'strict',
      });
      const result = evaluate('Bash', { command: 'git add && git commit' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('bashMode:strict');
    });

    it('default bashMode is strict', () => {
      const p = policy({ allow: ['Bash(*)'] });
      const result = evaluate('Bash', { command: 'echo hello; rm -rf /' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('bashMode:strict');
    });

    it('strict mode does not affect non-Bash tools', () => {
      const p = policy({ allow: ['Read(*)'] });
      const result = evaluate('Read', { file_path: 'file;name.txt' }, p);
      expect(result.decision).toBe('allow');
    });

    // Bug #1: ${...} must be caught by strict mode
    it('strict mode denies ${variable} expansion', () => {
      const p = policy({ bashMode: 'strict', allow: ['Bash(*)'] });
      const result = evaluate('Bash', { command: 'echo ${PATH}' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('bashMode:strict');
    });

    it('strict mode denies ${var:-default} expansion', () => {
      const p = policy({ bashMode: 'strict', allow: ['Bash(*)'] });
      const result = evaluate('Bash', { command: 'echo ${var:-default}' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('bashMode:strict');
    });

    it('strict mode denies bare ${variable}', () => {
      const p = policy({ bashMode: 'strict', allow: ['Bash(*)'] });
      const result = evaluate('Bash', { command: '${PATH}' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('bashMode:strict');
    });

    // Bug #7: bare \r must be caught
    it('strict mode denies bare \\r in command', () => {
      const p = policy({ bashMode: 'strict', allow: ['Bash(*)'] });
      const result = evaluate('Bash', { command: 'echo hello\rmalicious' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('bashMode:strict');
    });
  });

  // ── Glob matching ──────────────────────────────────────────────
  describe('glob matching', () => {
    it('matches exact path', () => {
      const p = policy({ allow: ['Read(src/foo.ts)'] });
      const result = evaluate('Read', { file_path: 'src/foo.ts' }, p);
      expect(result.decision).toBe('allow');
    });

    it('wildcard matches across path separators (bash: true)', () => {
      const p = policy({ allow: ['Read(*)'] });
      const result = evaluate('Read', { file_path: 'src/deeply/nested/file.ts' }, p);
      expect(result.decision).toBe('allow');
    });

    it('recursive ** glob', () => {
      const p = policy({ allow: ['Read(src/**)'] });
      const result = evaluate('Read', { file_path: 'src/foo/bar/baz.ts' }, p);
      expect(result.decision).toBe('allow');
    });

    it('does not match different path', () => {
      const p = policy({ allow: ['Read(src/**)'], fallback: 'deny' });
      const result = evaluate('Read', { file_path: 'lib/foo.ts' }, p);
      expect(result.decision).toBe('deny');
    });

    it('Bash(git *) does NOT match bare git', () => {
      const p = policy({ allow: ['Bash(git *)'], fallback: 'deny' });
      const result = evaluate('Bash', { command: 'git' }, p);
      expect(result.decision).toBe('deny');
    });

    it('Bash(git) matches bare git', () => {
      const p = policy({ allow: ['Bash(git)'] });
      const result = evaluate('Bash', { command: 'git' }, p);
      expect(result.decision).toBe('allow');
    });

    it('matches dotfiles', () => {
      const p = policy({ deny: ['Write(*.env*)'] });
      const result = evaluate('Write', { file_path: '.env.local' }, p);
      expect(result.decision).toBe('deny');
    });
  });

  // ── Multi-target semantics ─────────────────────────────────────
  describe('multi-target semantics', () => {
    it('deny matches ANY target (one bad file kills batch)', () => {
      const p = policy({
        deny: ['Edit(*.env*)'],
        allow: ['Edit(src/**)'],
      });
      const result = evaluate('Edit', { changes: { '.env': {}, 'src/foo.ts': {} } }, p);
      expect(result.decision).toBe('deny');
    });

    it('allow requires ALL targets to match', () => {
      const p = policy({ allow: ['Edit(src/**)'], fallback: 'deny' });
      const result = evaluate('Edit', { changes: { 'src/a.ts': {}, 'src/b.ts': {} } }, p);
      expect(result.decision).toBe('allow');
    });

    it('allow with partial coverage falls through', () => {
      const p = policy({ allow: ['Edit(src/**)'], fallback: 'deny' });
      const result = evaluate('Edit', { changes: { 'src/a.ts': {}, '/etc/passwd': {} } }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('fallback:deny');
    });
  });

  // ── Empty policy ───────────────────────────────────────────────
  describe('empty policy', () => {
    it('empty deny + empty allow + fallback deny = deny all', () => {
      const p = policy({ fallback: 'deny' });
      const result = evaluate('Read', { file_path: 'anything.ts' }, p);
      expect(result.decision).toBe('deny');
    });

    it('empty deny + empty allow + fallback escalate = escalate all', () => {
      const p = policy({ fallback: 'escalate' });
      const result = evaluate('Read', { file_path: 'anything.ts' }, p);
      expect(result.decision).toBe('escalate');
    });
  });

  // ── Empty targets (Agent tool) ─────────────────────────────────
  describe('empty targets (Agent tool)', () => {
    it('bare deny rule matches tool with no targets', () => {
      const p = policy({ deny: ['Agent'] });
      const result = evaluate('Agent', { prompt: 'do something' }, p);
      expect(result.decision).toBe('deny');
    });

    it('bare allow rule matches tool with no targets', () => {
      const p = policy({ allow: ['Agent'] });
      const result = evaluate('Agent', { prompt: 'do something' }, p);
      expect(result.decision).toBe('allow');
    });

    it('tool with empty targets and no matching rule falls to fallback', () => {
      const p = policy({ fallback: 'escalate' });
      const result = evaluate('Agent', { prompt: 'do something' }, p);
      expect(result.decision).toBe('escalate');
    });
  });

  // ── Tool name matching ─────────────────────────────────────────
  describe('tool name matching', () => {
    it('rules only match their declared tool name', () => {
      const p = policy({ deny: ['Bash(rm *)'], allow: ['Read(*)'] });
      const result = evaluate('Read', { file_path: 'rm -rf /' }, p);
      expect(result.decision).toBe('allow');
    });
  });

  // ── Latency tracking ──────────────────────────────────────────
  describe('result metadata', () => {
    it('includes latencyMs', () => {
      const p = policy({ fallback: 'deny' });
      const result = evaluate('Read', { file_path: 'test.ts' }, p);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── UNSAFE_BASH regex ──────────────────────────────────────────
  describe('UNSAFE_BASH regex', () => {
    it('matches semicolons', () => expect(UNSAFE_BASH.test('a;b')).toBe(true));
    it('matches pipes', () => expect(UNSAFE_BASH.test('a|b')).toBe(true));
    it('matches ampersands', () => expect(UNSAFE_BASH.test('a&b')).toBe(true));
    it('matches backticks', () => expect(UNSAFE_BASH.test('a`b`')).toBe(true));
    it('matches $(...)', () => expect(UNSAFE_BASH.test('a$(b)')).toBe(true));
    it('matches <<', () => expect(UNSAFE_BASH.test('cat <<EOF')).toBe(true));
    it('matches <()', () => expect(UNSAFE_BASH.test('diff <(a)')).toBe(true));
    it('matches newlines', () => expect(UNSAFE_BASH.test('a\nb')).toBe(true));
    it('does not match safe commands', () => expect(UNSAFE_BASH.test('git status')).toBe(false));
    it('does not match flags', () => expect(UNSAFE_BASH.test('ls -la')).toBe(false));
    // Bug #1: ${...} expansion
    it('matches ${...}', () => expect(UNSAFE_BASH.test('echo ${PATH}')).toBe(true));
    it('matches ${var:-default}', () => expect(UNSAFE_BASH.test('${var:-default}')).toBe(true));
    // Bug #7: bare \r
    it('matches \\r', () => expect(UNSAFE_BASH.test('a\rb')).toBe(true));
  });

  // ── Bug #3: undefined deny/allow arrays ────────────────────────
  describe('undefined deny/allow arrays', () => {
    it('does not crash when deny and allow are undefined', () => {
      const p = { fallback: 'deny' } as ArbiterPolicy;
      const result = evaluate('Bash', { command: 'git status' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('fallback:deny');
    });
  });

  // ── Bug #6: invalid config guard ───────────────────────────────
  describe('invalid config guard', () => {
    it('denies with invalid-config source when fallback=evaluate but no evaluator', () => {
      const p = policy({ fallback: 'evaluate' });
      const result = evaluate('Bash', { command: 'curl example.com' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('fallback:invalid-config');
    });
  });

  // ── Bug #8: bare deny rule against actual input ─────────────────
  describe('bare deny rule against input with targets', () => {
    it('deny: ["Bash"] denies Bash with a command', () => {
      const p = policy({ deny: ['Bash'] });
      const result = evaluate('Bash', { command: 'git status' }, p);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('deny:Bash');
    });
  });
});
