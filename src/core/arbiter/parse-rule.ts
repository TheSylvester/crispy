/**
 * Pattern Parser — Parse arbiter rule patterns
 *
 * Parses `ToolName(glob)` and bare `ToolName` patterns into structured
 * ParsedRule objects. Throws on malformed patterns.
 *
 * @module core/arbiter/parse-rule
 */

import type { ParsedRule } from './types.js';

/**
 * Parse an arbiter rule pattern into tool name and input glob.
 *
 * Accepted forms:
 * - `Bash(git *)` → { toolName: 'Bash', inputGlob: 'git *' }
 * - `Bash` → { toolName: 'Bash', inputGlob: '*' }
 *
 * @throws Error on malformed patterns (empty string, unbalanced parens, etc.)
 */
export function parseRule(pattern: string): ParsedRule {
  if (!pattern || !pattern.trim()) {
    throw new Error(`Invalid arbiter rule pattern: "${pattern}"`);
  }

  const trimmed = pattern.trim();
  const m = trimmed.match(/^([^(]+?)(?:\((.+)\))?$/);
  if (!m) {
    throw new Error(`Invalid arbiter rule pattern: "${pattern}"`);
  }

  const toolName = m[1]!.trim();
  if (!toolName) {
    throw new Error(`Invalid arbiter rule pattern: "${pattern}"`);
  }

  return {
    toolName,
    inputGlob: m[2] ?? '*',
  };
}
