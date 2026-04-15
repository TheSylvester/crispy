/**
 * Policy Composition — Merge base + override policies
 *
 * Deny rules union (safety accumulates, can never be removed).
 * Allow rules: override goes first (takes precedence in first-match).
 * Fallback, evaluator, bashMode: override wins.
 *
 * @module core/arbiter/compose-policy
 */

import type { ArbiterPolicy } from './types.js';

/**
 * Compose two policies: base + override.
 *
 * - `deny`: union (both apply — deny can never be removed)
 * - `allow`: override-first (override rules checked before base)
 * - `fallback`: override wins (falls back to base if undefined)
 * - `evaluator`: override wins (falls back to base if undefined)
 * - `bashMode`: override wins (falls back to base if undefined)
 */
export function composePolicies(base: ArbiterPolicy, override: ArbiterPolicy): ArbiterPolicy {
  return {
    deny: [...base.deny, ...override.deny],
    allow: [...override.allow, ...base.allow],
    fallback: override.fallback ?? base.fallback,
    evaluator: override.evaluator ?? base.evaluator,
    bashMode: override.bashMode ?? base.bashMode,
  };
}
