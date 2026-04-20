/**
 * Tests for CLI Version Gate — semver comparison, tri-state check,
 * and warn-once idempotency.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  compareSemver,
  checkCliVersion,
  cliSupportsThinkingDisplay,
  warnOnceIfOld,
  __resetWarnCacheForTest,
  EXPECTED_CLI_VERSION,
  MIN_DISPLAY_CLI_VERSION,
} from '../src/core/adapters/claude/cli-version-gate.js';

// Capture log calls so we can assert idempotency without depending on output format.
const logSpy = vi.fn();
vi.mock('../src/core/log.js', () => ({
  log: (...args: unknown[]) => logSpy(...args),
}));

beforeEach(() => {
  logSpy.mockReset();
  __resetWarnCacheForTest();
});

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('2.1.114', '2.1.114')).toBe(0);
  });

  it('returns -1 when a < b on patch', () => {
    expect(compareSemver('2.1.80', '2.1.114')).toBe(-1);
  });

  it('returns 1 when a > b on patch', () => {
    expect(compareSemver('2.1.114', '2.1.80')).toBe(1);
  });

  it('compares numerically, not lexicographically', () => {
    // '9' > '1' lexicographically would break ordering; numeric compare is correct.
    expect(compareSemver('2.1.9', '2.1.114')).toBe(-1);
    expect(compareSemver('2.10.0', '2.1.114')).toBe(1);
  });

  it('respects major bumps', () => {
    expect(compareSemver('3.0.0', '2.1.114')).toBe(1);
    expect(compareSemver('2.1.114', '3.0.0')).toBe(-1);
  });

  it('returns null for empty string', () => {
    expect(compareSemver('', '2.1.114')).toBeNull();
    expect(compareSemver('2.1.114', '')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(compareSemver('garbage', '2.1.114')).toBeNull();
    expect(compareSemver('2.1', '2.1.114')).toBeNull();
  });

  it('strips pre-release and still compares', () => {
    expect(compareSemver('2.1.114-beta', '2.1.114')).toBe(0);
  });
});

describe('checkCliVersion', () => {
  it('reports supported for matching version', () => {
    const r = checkCliVersion(EXPECTED_CLI_VERSION);
    expect(r.status).toBe('supported');
    expect(r.observed).toBe(EXPECTED_CLI_VERSION);
    expect(r.expected).toBe(EXPECTED_CLI_VERSION);
  });

  it('reports supported for newer version', () => {
    expect(checkCliVersion('99.0.0').status).toBe('supported');
  });

  it('reports too_old for older patch', () => {
    expect(checkCliVersion('2.1.80').status).toBe('too_old');
  });

  it('reports too_old for older minor', () => {
    expect(checkCliVersion('2.0.114').status).toBe('too_old');
  });

  it('reports unknown for empty string (no warn)', () => {
    expect(checkCliVersion('').status).toBe('unknown');
  });

  it('reports unknown for unparseable string', () => {
    expect(checkCliVersion('garbage').status).toBe('unknown');
    expect(checkCliVersion('2.1').status).toBe('unknown');
  });
});

describe('cliSupportsThinkingDisplay', () => {
  it('pins the floor at 2.1.94', () => {
    expect(MIN_DISPLAY_CLI_VERSION).toBe('2.1.94');
  });

  it('accepts the exact floor version', () => {
    expect(cliSupportsThinkingDisplay('2.1.94')).toBe(true);
  });

  it('accepts versions above the floor', () => {
    expect(cliSupportsThinkingDisplay('2.1.112')).toBe(true);
    expect(cliSupportsThinkingDisplay('2.1.114')).toBe(true);
    expect(cliSupportsThinkingDisplay('3.0.0')).toBe(true);
  });

  it('rejects versions below the floor', () => {
    expect(cliSupportsThinkingDisplay('2.1.93')).toBe(false);
    expect(cliSupportsThinkingDisplay('2.1.80')).toBe(false);
    expect(cliSupportsThinkingDisplay('2.0.999')).toBe(false);
  });

  it('defaults to true for empty / unparseable observed (optimistic)', () => {
    expect(cliSupportsThinkingDisplay('')).toBe(true);
    expect(cliSupportsThinkingDisplay('garbage')).toBe(true);
    expect(cliSupportsThinkingDisplay('2.1')).toBe(true);
  });
});

describe('warnOnceIfOld', () => {
  it('does not warn for supported', () => {
    warnOnceIfOld({ status: 'supported', expected: '2.1.114', observed: '2.1.114' });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does not warn for unknown', () => {
    warnOnceIfOld({ status: 'unknown', expected: '2.1.114', observed: '' });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('warns once for too_old', () => {
    warnOnceIfOld({ status: 'too_old', expected: '2.1.114', observed: '2.1.80' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = logSpy.mock.calls[0][0] as { level: string; source: string };
    expect(entry.level).toBe('warn');
    expect(entry.source).toBe('claude-adapter');
  });

  it('is idempotent across repeated too_old calls', () => {
    const r = { status: 'too_old' as const, expected: '2.1.114', observed: '2.1.80' };
    warnOnceIfOld(r);
    warnOnceIfOld(r);
    warnOnceIfOld(r);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
