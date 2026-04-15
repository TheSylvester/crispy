/**
 * Arbiter Types — Policy schema, evaluation result types
 *
 * Defines the data structures for the universal tool call safety layer.
 * No runtime logic — pure type definitions.
 *
 * @module core/arbiter/types
 */

// ============================================================================
// Policy Schema
// ============================================================================

export interface ArbiterEvaluator {
  /** Agent mission context for LLM judgment */
  prompt: string;
  /** LLM model to use (default: haiku) */
  model?: string;
  /** Timeout in ms (default: 3000) */
  timeout?: number;
}

export interface ArbiterPolicy {
  /** Deny rules — any match → deny. Evaluated before allow rules. */
  deny: string[];
  /** Allow rules — first match → allow. Evaluated top-to-bottom. */
  allow: string[];
  /** What to do when no rule matches */
  fallback: 'deny' | 'escalate' | 'evaluate';
  /** Required when fallback = 'evaluate' */
  evaluator?: ArbiterEvaluator;
  /** Bash safety mode (default: 'strict') */
  bashMode?: 'strict' | 'permissive';
}

// ============================================================================
// Evaluation Result
// ============================================================================

export interface ArbiterResult {
  /** The decision: allow, deny, or escalate to human */
  decision: 'allow' | 'deny' | 'escalate';
  /** Which rule matched, or 'bashMode', 'fallback', 'fallback:needs-llm', etc. */
  source: string;
  /** Evaluation latency in milliseconds */
  latencyMs: number;
}

// ============================================================================
// Parsed Rule
// ============================================================================

export interface ParsedRule {
  /** Exact tool name (no wildcards in v1) */
  toolName: string;
  /** Glob pattern to match against canonical input (default: '*') */
  inputGlob: string;
}
