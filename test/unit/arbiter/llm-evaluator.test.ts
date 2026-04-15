import { describe, it, expect } from 'vitest';
import { evaluateWithLlm, parseArbiterResponse } from '../../../src/core/arbiter/llm-evaluator.js';

describe('llm-evaluator', () => {
  // ── parseArbiterResponse ─────────────────────────────────────────
  describe('parseArbiterResponse', () => {
    it('parses allow decision', () => {
      const result = parseArbiterResponse('{"decision": "allow"}');
      expect(result.decision).toBe('allow');
      expect(result.source).toBe('fallback:llm');
    });

    it('parses deny decision with reason', () => {
      const result = parseArbiterResponse('{"decision": "deny", "reason": "dangerous"}');
      expect(result.decision).toBe('deny');
      expect(result.source).toContain('dangerous');
    });

    it('returns deny on parse failure', () => {
      const result = parseArbiterResponse('invalid json');
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('fallback:llm-parse-error');
    });

    it('returns deny for unknown decision values', () => {
      const result = parseArbiterResponse('{"decision": "escalate"}');
      expect(result.decision).toBe('deny');
      expect(result.source).toBe('fallback:llm-parse-error');
    });
  });

  // ── Bug #4: stub returns escalate with correct source ────────────
  describe('evaluateWithLlm stub', () => {
    it('returns escalate with source fallback:llm-stub when no dispatch provided', async () => {
      const result = await evaluateWithLlm(
        'Bash',
        { command: 'rm -rf /' },
        { prompt: 'test agent' },
      );
      expect(result.decision).toBe('escalate');
      expect(result.source).toBe('fallback:llm-stub');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('uses dispatch function when provided', async () => {
      const dispatch = async () => '{"decision": "allow"}';
      const result = await evaluateWithLlm(
        'Bash',
        { command: 'git status' },
        { prompt: 'test agent' },
        dispatch,
      );
      expect(result.decision).toBe('allow');
      expect(result.source).toBe('fallback:llm');
    });
  });
});
