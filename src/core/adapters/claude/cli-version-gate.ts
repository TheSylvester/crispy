/**
 * CLI Version Gate
 *
 * Crispy overrides `pathToClaudeCodeExecutable` with the user's system
 * `claude` binary, bypassing the CLI bundled with the Agent SDK. After an
 * SDK bump, the user's system CLI can lag behind what the SDK speaks —
 * silently. This module compares the version captured from the SDK init
 * message against `EXPECTED_CLI_VERSION` (the version the SDK was built
 * against) and warns once per activation when the user's CLI is older.
 *
 * Warn-only, not block. Developer audience — a hard block would brick
 * the product if a user legitimately pins an older CLI.
 *
 * @module cli-version-gate
 */

import { log } from '../../log.js';
import { EXPECTED_CLI_VERSION } from '../../../generated/sdk-version.js';

export { EXPECTED_CLI_VERSION };

/** Numeric-per-component semver compare. Returns null for malformed input. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (v: string): number[] | null => {
    if (!v) return null;
    // Strip pre-release / build metadata (`2.1.114-beta`, `2.1.114+rc1`).
    const core = v.split(/[-+]/, 1)[0];
    const parts = core.split('.');
    if (parts.length !== 3) return null;
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null;
      nums.push(Number(p));
    }
    return nums;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export interface CliVersionCheckResult {
  status: 'supported' | 'too_old' | 'unknown';
  expected: string;
  observed: string;
}

/**
 * Compare an observed CLI version string against the SDK's expected version.
 *
 * Tri-state:
 * - empty / unparseable observed → `'unknown'` (older CLIs legitimately
 *   may not emit `claude_code_version`; do not warn).
 * - observed < expected → `'too_old'` (warn).
 * - observed >= expected → `'supported'`.
 */
export function checkCliVersion(observed: string): CliVersionCheckResult {
  const expected = EXPECTED_CLI_VERSION;
  if (!observed) {
    return { status: 'unknown', expected, observed };
  }
  const cmp = compareSemver(observed, expected);
  if (cmp === null) {
    return { status: 'unknown', expected, observed };
  }
  if (cmp < 0) return { status: 'too_old', expected, observed };
  return { status: 'supported', expected, observed };
}

// Module-local warn cache. One warn per extension activation — CLI version
// doesn't change between sessions. Cheaper than per-session tracking and
// doesn't grow unbounded across ephemeral Rosie / recall sessions.
let hasWarned = false;

/** Reset the warn cache. Test-only — not exported from a public barrel. */
export function __resetWarnCacheForTest(): void {
  hasWarned = false;
}

/**
 * Log a warning once per activation when the CLI is older than the SDK
 * expects. No-op for `'supported'` / `'unknown'`.
 */
export function warnOnceIfOld(result: CliVersionCheckResult): void {
  if (result.status !== 'too_old') return;
  if (hasWarned) return;
  hasWarned = true;
  log({
    level: 'warn',
    source: 'claude-adapter',
    summary: `Claude CLI ${result.observed} is older than SDK-expected ${result.expected}. Some features may silently no-op. Update with \`npm i -g @anthropic-ai/claude-code\`.`,
    data: { expected: result.expected, observed: result.observed },
  });
}
