/**
 * Projection Sync — Mirrors buffer sections to Discord messages
 *
 * On each heartbeat tick, syncs at most ONE dirty section:
 * - New sections → POST (create Discord message)
 * - Changed sections → PATCH (edit existing message)
 * Tracks section-to-message-ID mapping.
 *
 * @module message-view/projection
 */

import { log } from '../log.js';
import { sendMessage, editMessage } from './discord-transport.js';
import type { MessageBuffer } from './buffer.js';

const SOURCE = 'message-view/projection';
const DISCORD_MAX_LENGTH = 4000;

export interface ProjectionState {
  discordChannelId: string;
  /** Maps section.id → Discord message ID */
  sectionToMessageId: Map<string, string>;
}

export function createProjection(discordChannelId: string): ProjectionState {
  return {
    discordChannelId,
    sectionToMessageId: new Map(),
  };
}

/**
 * Sync one dirty section to Discord. Call on each heartbeat tick.
 * Returns true if a sync was performed, false if nothing was dirty.
 */
export async function syncOneDirtySection(
  state: ProjectionState,
  buffer: MessageBuffer,
): Promise<boolean> {
  const section = buffer.sections.find((s) => s.dirty);
  if (!section) return false;

  const content = section.content.slice(0, DISCORD_MAX_LENGTH);
  if (!content) {
    // Empty content — mark clean but don't send
    section.dirty = false;
    return true;
  }

  const existingMessageId = state.sectionToMessageId.get(section.id);

  try {
    if (existingMessageId) {
      // PATCH existing message
      await editMessage(state.discordChannelId, existingMessageId, content);
    } else {
      // POST new message
      const result = await sendMessage(state.discordChannelId, content);
      state.sectionToMessageId.set(section.id, result.id);
    }
    section.dirty = false;
  } catch (err) {
    log({
      source: SOURCE,
      level: 'error',
      summary: `failed to sync section "${section.id}"`,
      data: err,
    });
    // Don't throw — a failed sync shouldn't crash the heartbeat.
    // Leave dirty so it retries next tick.
  }

  return true;
}

export function clearProjection(state: ProjectionState): void {
  state.sectionToMessageId.clear();
}
