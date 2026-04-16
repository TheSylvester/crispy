/**
 * Static Evaluation Engine — Core arbiter evaluation function
 *
 * Implements the 4-step evaluation flow:
 * 1. Bash safety check (bashMode: 'strict' default)
 * 2. Deny rules — any match → deny
 * 3. Allow rules — first match → allow
 * 4. Fallback → deny | escalate | evaluate
 *
 * Pure synchronous function. No adapters, no transport, no UI.
 *
 * @module core/arbiter/evaluate
 */

import picomatch from 'picomatch';
import type { ArbiterPolicy, ArbiterResult } from './types.js';
import { parseRule } from './parse-rule.js';
import { normalizeMatchTarget } from './normalize-input.js';
import { log } from '../log.js';

/**
 * Regex matching shell metacharacters that are unsafe in strict bash mode.
 * Matches: ; | & ` $( << <( and newlines
 */
export const UNSAFE_BASH = /[;|&`]|\$\(|\$\{|<<|<\(|\r|\n/;

/** Picomatch options: bash mode for cross-/ matching, no extglob, dotfiles */
const PICO_OPTS: picomatch.PicomatchOptions = { bash: true, noextglob: true, dot: true };

/**
 * Truncate a string for logging readability.
 */
function truncate(s: string, max = 200): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/**
 * Evaluate a tool call against a policy.
 *
 * Returns an ArbiterResult with the decision, the source (which rule
 * matched), and the evaluation latency.
 */
export function evaluate(
  toolName: string,
  input: unknown,
  policy: ArbiterPolicy,
): ArbiterResult {
  const start = performance.now();
  const targets = normalizeMatchTarget(toolName, input);
  const inputSummary = truncate(targets.join(', ') || '(no input)');

  // ── Step 1: Bash safety check ──────────────────────────────────────
  const bashMode = policy.bashMode ?? 'strict';
  if (toolName === 'Bash' && bashMode === 'strict') {
    for (const target of targets) {
      if (UNSAFE_BASH.test(target)) {
        const result: ArbiterResult = {
          decision: 'deny',
          source: 'bashMode:strict',
          latencyMs: performance.now() - start,
        };
        log({
          source: 'arbiter',
          level: 'info',
          summary: `deny: Bash "${inputSummary}" blocked by strict bash mode`,
        });
        return result;
      }
    }
  }

  // ── Step 1.5: Invalid config guard ──────────────────────────────────
  if (policy.fallback === 'evaluate' && !policy.evaluator) {
    log({
      source: 'arbiter',
      level: 'warn',
      summary: `deny: fallback=evaluate but no evaluator configured — treating as deny`,
    });
    return {
      decision: 'deny',
      source: 'fallback:invalid-config',
      latencyMs: performance.now() - start,
    };
  }

  // ── Step 2: Deny rules — any match → deny ─────────────────────────
  const denyRules = policy.deny ?? [];
  for (const pattern of denyRules) {
    const rule = parseRule(pattern);
    if (rule.toolName !== toolName) continue;

    // Bare tool name match (glob is '*') with empty targets — deny on tool name alone.
    // Glob-scoped rules (e.g. Bash(git *)) must NOT match empty targets — that would
    // be a sandbox escape when the normalizer can't extract input from a new vendor shape.
    if (targets.length === 0) {
      if (rule.inputGlob === '*') {
        const result: ArbiterResult = {
          decision: 'deny',
          source: `deny:${pattern}`,
          latencyMs: performance.now() - start,
        };
        log({
          source: 'arbiter',
          level: 'info',
          summary: `deny: ${toolName} "${inputSummary}" matched rule ${pattern}`,
        });
        return result;
      }
      continue;
    }

    // Deny matches ANY target — one bad target kills the call
    const isMatch = picomatch(rule.inputGlob, PICO_OPTS);
    if (targets.some((t) => isMatch(t))) {
      const result: ArbiterResult = {
        decision: 'deny',
        source: `deny:${pattern}`,
        latencyMs: performance.now() - start,
      };
      log({
        source: 'arbiter',
        level: 'info',
        summary: `deny: ${toolName} "${inputSummary}" matched rule ${pattern}`,
      });
      return result;
    }
  }

  // ── Step 3: Allow rules — first match → allow ─────────────────────
  const allowRules = policy.allow ?? [];
  for (const pattern of allowRules) {
    const rule = parseRule(pattern);
    if (rule.toolName !== toolName) continue;

    // Bare tool name match with empty targets — allow on tool name alone.
    // Glob-scoped rules skip empty targets (same rationale as deny branch).
    if (targets.length === 0) {
      if (rule.inputGlob === '*') {
        const result: ArbiterResult = {
          decision: 'allow',
          source: `allow:${pattern}`,
          latencyMs: performance.now() - start,
        };
        log({
          source: 'arbiter',
          level: 'info',
          summary: `allow: ${toolName} "${inputSummary}" matched rule ${pattern}`,
        });
        return result;
      }
      continue;
    }

    // Allow requires ALL targets to match
    const isMatch = picomatch(rule.inputGlob, PICO_OPTS);
    if (targets.every((t) => isMatch(t))) {
      const result: ArbiterResult = {
        decision: 'allow',
        source: `allow:${pattern}`,
        latencyMs: performance.now() - start,
      };
      log({
        source: 'arbiter',
        level: 'info',
        summary: `allow: ${toolName} "${inputSummary}" matched rule ${pattern}`,
      });
      return result;
    }
  }

  // ── Step 4: Fallback ───────────────────────────────────────────────
  const fallback = policy.fallback;

  if (fallback === 'evaluate') {
    // Signal that LLM evaluation is needed — caller handles async dispatch
    const result: ArbiterResult = {
      decision: 'escalate',
      source: 'fallback:needs-llm',
      latencyMs: performance.now() - start,
    };
    log({
      source: 'arbiter',
      level: 'info',
      summary: `escalate: ${toolName} "${inputSummary}" — no rule matched, needs LLM evaluation`,
    });
    return result;
  }

  const decision = fallback === 'escalate' ? 'escalate' as const : 'deny' as const;
  const result: ArbiterResult = {
    decision,
    source: `fallback:${fallback}`,
    latencyMs: performance.now() - start,
  };
  log({
    source: 'arbiter',
    level: 'info',
    summary: `${decision}: ${toolName} "${inputSummary}" — no rule matched, fallback=${fallback}`,
  });
  return result;
}
