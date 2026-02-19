/**
 * Blocks Fork Integration — entry boundary detection for fork buttons
 *
 * Provides utilities for detecting entry boundaries within block-level
 * rendering to determine where fork/rewind buttons should appear.
 *
 * Fork buttons appear at the first block of each user-role entry that
 * has a valid fork target (preceding assistant message).
 *
 * @module webview/blocks/BlocksForkIntegration
 */

import type { RichBlock } from './types.js';

/**
 * Result of checking whether to show fork buttons for a block.
 */
interface ForkButtonCheck {
  /** Whether to show fork buttons */
  show: boolean;
  /** The assistant message ID to fork from (null if first user message) */
  targetAssistantId: string | null;
}

/**
 * Determine if fork buttons should be shown for a block.
 *
 * Fork buttons appear at the first block of each user-role entry.
 * Uses entry boundaries detected by comparing entryUuid across blocks.
 *
 * @param block - The current block to check
 * @param prevBlock - The previous block in the render sequence
 * @param forkTargets - Map of user entry UUID → preceding assistant UUID
 * @returns Whether to show fork buttons and the target assistant ID
 */
export function shouldShowForkButtons(
  block: RichBlock,
  prevBlock: RichBlock | undefined,
  forkTargets: Map<string, string>,
): ForkButtonCheck {
  // Only show fork buttons on user messages
  if (block.context.role !== 'user') {
    return { show: false, targetAssistantId: null };
  }

  // Is this the first block of a new entry?
  // True if no previous block or if the entry UUID changed
  const isEntryLeader = !prevBlock || prevBlock.context.entryUuid !== block.context.entryUuid;
  if (!isEntryLeader) {
    return { show: false, targetAssistantId: null };
  }

  // Look up the fork target for this entry
  const target = forkTargets.get(block.context.entryUuid);

  // If target is undefined, this entry isn't in the fork targets map
  if (target === undefined) {
    return { show: false, targetAssistantId: null };
  }

  // target === '' means first user message (no preceding assistant)
  // target === '<uuid>' means normal fork case
  return {
    show: true,
    targetAssistantId: target || null,
  };
}

/**
 * Check if a block is the first block of its entry.
 * Used to determine where entry-level UI should render.
 */
export function isEntryLeader(
  block: RichBlock,
  prevBlock: RichBlock | undefined,
): boolean {
  return !prevBlock || prevBlock.context.entryUuid !== block.context.entryUuid;
}

/**
 * Check if a block is the last block of its entry.
 * Used to determine where entry-level trailing UI should render.
 */
export function isEntryTrailer(
  block: RichBlock,
  nextBlock: RichBlock | undefined,
): boolean {
  return !nextBlock || nextBlock.context.entryUuid !== block.context.entryUuid;
}
