/**
 * Policy Validation — Validate arbiter policy at load time
 *
 * Rejects invalid configurations early. Returns warnings for
 * non-fatal issues (unknown tool names from plugins/MCP).
 *
 * @module core/arbiter/validate-policy
 */

import type { ArbiterPolicy } from './types.js';
import { parseRule } from './parse-rule.js';

/** Known built-in tool names for warning purposes */
const KNOWN_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebFetch', 'Agent', 'WebSearch', 'NotebookEdit',
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate an arbiter policy configuration.
 *
 * Errors are fatal — the policy should not be used.
 * Warnings are informational — the policy is usable but may have issues.
 */
export function validatePolicy(policy: ArbiterPolicy): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // fallback: 'evaluate' requires an evaluator
  if (policy.fallback === 'evaluate' && !policy.evaluator) {
    errors.push("fallback is 'evaluate' but no evaluator is configured");
  }

  // Validate all patterns in deny and allow lists
  const allPatterns = [
    ...policy.deny.map((p) => ({ pattern: p, list: 'deny' })),
    ...policy.allow.map((p) => ({ pattern: p, list: 'allow' })),
  ];

  for (const { pattern, list } of allPatterns) {
    try {
      const parsed = parseRule(pattern);
      // Warn on unknown tool names (don't error — MCP/plugins may add tools)
      if (!KNOWN_TOOLS.has(parsed.toolName)) {
        warnings.push(`Unknown tool name "${parsed.toolName}" in ${list} rule "${pattern}"`);
      }
    } catch (err) {
      errors.push(`Malformed pattern in ${list} list: "${pattern}" — ${(err as Error).message}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
