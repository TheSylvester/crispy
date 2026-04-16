import { describe, it, expect } from 'vitest';
import { normalizeMatchTarget } from '../../../src/core/arbiter/normalize-input.js';

describe('normalizeMatchTarget', () => {
  // ── Claude Bash ──────────────────────────────────────────────────
  describe('Bash', () => {
    it('extracts command from Claude Bash input', () => {
      expect(normalizeMatchTarget('Bash', { command: 'git status' })).toEqual(['git status']);
    });

    it('strips Codex /bin/bash -lc wrapper (double quotes)', () => {
      expect(
        normalizeMatchTarget('Bash', { command: '/bin/bash -lc "git status"' }),
      ).toEqual(['git status']);
    });

    // Bug #2: single-quote Codex wrapper
    it('strips Codex /bin/bash -lc wrapper (single quotes)', () => {
      expect(
        normalizeMatchTarget('Bash', { command: "/bin/bash -lc 'rm -rf /'" }),
      ).toEqual(['rm -rf /']);
    });

    it('strips Codex /bin/bash -lc wrapper (single quotes with spaces)', () => {
      expect(
        normalizeMatchTarget('Bash', { command: "/bin/bash -lc 'git status --short'" }),
      ).toEqual(['git status --short']);
    });

    it('returns raw command when wrapper does not match', () => {
      expect(
        normalizeMatchTarget('Bash', { command: '/bin/sh -c "git status"' }),
      ).toEqual(['/bin/sh -c "git status"']);
    });

    it('returns empty array for missing command', () => {
      expect(normalizeMatchTarget('Bash', {})).toEqual([]);
    });

    it('returns empty array for empty command', () => {
      expect(normalizeMatchTarget('Bash', { command: '' })).toEqual([]);
    });
  });

  // ── Read / Write ─────────────────────────────────────────────────
  describe('Read', () => {
    it('extracts file_path', () => {
      expect(normalizeMatchTarget('Read', { file_path: 'src/foo.ts' })).toEqual(['src/foo.ts']);
    });

    it('returns empty for missing file_path', () => {
      expect(normalizeMatchTarget('Read', {})).toEqual([]);
    });
  });

  describe('Write', () => {
    it('extracts file_path', () => {
      expect(normalizeMatchTarget('Write', { file_path: '.env.local' })).toEqual(['.env.local']);
    });
  });

  // ── Edit ─────────────────────────────────────────────────────────
  describe('Edit', () => {
    it('extracts file_path from Claude Edit', () => {
      expect(
        normalizeMatchTarget('Edit', { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' }),
      ).toEqual(['src/foo.ts']);
    });

    it('extracts file paths from Codex Edit changes map', () => {
      const result = normalizeMatchTarget('Edit', {
        changes: { 'src/a.ts': {}, 'src/b.ts': {} },
      });
      expect(result).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('returns empty for Edit with no file_path or changes', () => {
      expect(normalizeMatchTarget('Edit', {})).toEqual([]);
    });
  });

  // ── Glob / Grep ──────────────────────────────────────────────────
  describe('Glob', () => {
    it('extracts pattern', () => {
      expect(normalizeMatchTarget('Glob', { pattern: '**/*.ts' })).toEqual(['**/*.ts']);
    });
  });

  describe('Grep', () => {
    it('extracts pattern', () => {
      expect(normalizeMatchTarget('Grep', { pattern: 'TODO' })).toEqual(['TODO']);
    });
  });

  // ── WebFetch ─────────────────────────────────────────────────────
  describe('WebFetch', () => {
    it('extracts url', () => {
      expect(normalizeMatchTarget('WebFetch', { url: 'https://example.com' })).toEqual([
        'https://example.com',
      ]);
    });
  });

  // ── Bug #5: Agent explicit case ────────────────────────────────
  describe('Agent', () => {
    it('returns empty array for Agent tool', () => {
      expect(normalizeMatchTarget('Agent', { prompt: 'do something' })).toEqual([]);
    });

    it('returns empty array for Agent even with metadata.path', () => {
      expect(
        normalizeMatchTarget('Agent', { prompt: 'do something', metadata: { path: 'src/foo.ts' } }),
      ).toEqual([]);
    });
  });

  // ── OpenCode / unknown vendors ───────────────────────────────────
  describe('unknown vendor', () => {
    it('extracts metadata.path (OpenCode)', () => {
      expect(
        normalizeMatchTarget('SomeTool', { metadata: { path: 'src/foo.ts' } }),
      ).toEqual(['src/foo.ts']);
    });

    it('falls back to pattern field', () => {
      expect(normalizeMatchTarget('SomeTool', { pattern: '*.ts' })).toEqual(['*.ts']);
    });

    it('returns empty for unrecognized input shape', () => {
      expect(normalizeMatchTarget('SomeTool', { randomField: 'value' })).toEqual([]);
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────
  describe('edge cases', () => {
    it('returns empty for null input', () => {
      expect(normalizeMatchTarget('Bash', null)).toEqual([]);
    });

    it('returns empty for undefined input', () => {
      expect(normalizeMatchTarget('Bash', undefined)).toEqual([]);
    });

    it('returns empty for non-object input', () => {
      expect(normalizeMatchTarget('Bash', 'string')).toEqual([]);
    });

    it('returns empty for Agent tool (no input matching in v1)', () => {
      expect(normalizeMatchTarget('Agent', { prompt: 'do something' })).toEqual([]);
    });

    // Bug #9: array input
    it('returns empty for array input', () => {
      expect(normalizeMatchTarget('Bash', [{ command: 'git status' }])).toEqual([]);
    });

    it('returns empty for empty array input', () => {
      expect(normalizeMatchTarget('Bash', [])).toEqual([]);
    });
  });
});
