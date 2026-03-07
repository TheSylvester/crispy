/**
 * Rosie Tracker Validator — Constraint validation for parsed tracker blocks
 *
 * Checks each TrackerBlock against business rules (status enum, ID references,
 * required fields, category enum). Invalid blocks are dropped with error
 * messages — not fatal to the batch. Does not mutate input blocks.
 *
 * @module rosie/tracker/validator
 */

import type { TrackerBlock, ValidationResult } from './types.js';
import { VALID_STATUSES, VALID_CATEGORIES } from './types.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Validate an array of TrackerBlocks against business constraints.
 *
 * Returns { valid, errors } — invalid blocks are dropped, not fatal.
 * Does not mutate input blocks.
 */
export function validateTrackerBlocks(
  blocks: TrackerBlock[],
  existingProjectIds: Set<string>,
): ValidationResult {
  const valid: TrackerBlock[] = [];
  const errors: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockErrors: string[] = [];

    // Required fields (defensive — extractor already filters these)
    if (!block.project.title) {
      blockErrors.push(`Block ${i}: missing title`);
    }
    if (!block.project.status) {
      blockErrors.push(`Block ${i}: missing status`);
    }

    // Status enum check
    if (block.project.status && !(VALID_STATUSES as readonly string[]).includes(block.project.status)) {
      blockErrors.push(`Block ${i}: invalid status "${block.project.status}" (expected: ${VALID_STATUSES.join(', ')})`);
    }

    // Category — warn in errors list but don't reject (spec says category is open-ended)
    if (block.project.category && !(VALID_CATEGORIES as readonly string[]).includes(block.project.category)) {
      errors.push(`Block ${i}: unknown category "${block.project.category}" (expected: ${VALID_CATEGORIES.join(', ')})`);
    }

    // ID reference check — non-empty ID must exist
    if (block.project.id && !existingProjectIds.has(block.project.id)) {
      blockErrors.push(`Block ${i}: project id "${block.project.id}" not found in existing projects`);
    }

    if (blockErrors.length > 0) {
      errors.push(...blockErrors);
    } else {
      valid.push(block);
    }
  }

  return { valid, errors };
}
