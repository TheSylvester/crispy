/**
 * Forum Channel Management — create, repair, and rejoin forum threads
 *
 * Manages the "crispy-sessions" forum channel in a Discord guild.
 * Zero coupling to watch state; depends only on discord-transport.
 *
 * @module message-view/forum
 */

import { log } from '../log.js';
import {
  discordFetch,
  createChannel,
  getGuildChannels,
  getActiveThreads,
} from './discord-transport.js';

const SOURCE = 'message-view/forum';
const FORUM_ALLOW_BITS = '76864'; // VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY + MANAGE_MESSAGES + ADD_REACTIONS
const GUILD_FORUM = 15; // Discord channel type for forum channels

export async function ensureForumChannel(guildId: string, botId: string, ownerId: string | null): Promise<string> {
  const channels = await getGuildChannels(guildId);
  const existing = channels.find(c => c.name === 'crispy-sessions' && c.type === GUILD_FORUM);

  if (existing) {
    await repairForumPermissions(existing.id, guildId, botId, ownerId);
    return existing.id;
  }

  const permissionOverwrites: unknown[] = [
    { id: guildId, type: 0, deny: '1024' },
    { id: botId, type: 1, allow: FORUM_ALLOW_BITS },
  ];
  if (ownerId) {
    permissionOverwrites.push({ id: ownerId, type: 1, allow: FORUM_ALLOW_BITS });
  }

  const forum = await createChannel(guildId, 'crispy-sessions', {
    type: GUILD_FORUM,
    permissionOverwrites,
  });
  log({ source: SOURCE, level: 'info', summary: `created forum channel: ${forum.id}` });
  return forum.id;
}

export async function rejoinForumThreads(guildId: string, forumId: string): Promise<void> {
  // Active (non-archived) threads — guild-level endpoint
  const active = await getActiveThreads(guildId);
  const activeForum = active.filter(t => t.parent_id === forumId);

  // Archived threads — channel-level endpoint (tearDown archives all watched threads)
  let archivedForum: Array<{ id: string }> = [];
  try {
    const archived = await discordFetch('GET', `/channels/${forumId}/threads/archived/public`) as {
      threads?: Array<{ id: string; parent_id: string }>;
    };
    archivedForum = archived.threads ?? [];
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: 'failed to fetch archived forum threads', data: err });
  }

  // Deduplicate by thread ID
  const seen = new Set<string>();
  const allThreads: Array<{ id: string }> = [];
  for (const t of [...activeForum, ...archivedForum]) {
    if (!seen.has(t.id)) { seen.add(t.id); allThreads.push(t); }
  }
  if (allThreads.length === 0) return;

  const joinTasks = allThreads.map(t =>
    discordFetch('PUT', `/channels/${t.id}/thread-members/@me`).catch((err) => {
      log({ source: SOURCE, level: 'debug', summary: `failed to join thread ${t.id}`, data: err });
    })
  );
  await Promise.all(joinTasks);
  log({ source: SOURCE, level: 'info', summary: `re-joined ${allThreads.length} forum thread${allThreads.length > 1 ? 's' : ''} (${activeForum.length} active, ${archivedForum.length} archived)` });
}

async function repairForumPermissions(channelId: string, guildId: string, botId: string, ownerId: string | null): Promise<void> {
  try {
    const tasks: Promise<unknown>[] = [
      discordFetch('PUT', `/channels/${channelId}/permissions/${guildId}`, { type: 0, deny: '1024' }),
      discordFetch('PUT', `/channels/${channelId}/permissions/${botId}`, { type: 1, allow: FORUM_ALLOW_BITS }),
    ];
    if (ownerId) {
      tasks.push(discordFetch('PUT', `/channels/${channelId}/permissions/${ownerId}`, { type: 1, allow: FORUM_ALLOW_BITS }));
    }
    await Promise.all(tasks);
    log({ source: SOURCE, level: 'debug', summary: 'forum permissions verified' });
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: 'failed to repair forum permissions', data: err });
  }
}
