/**
 * Forum Channel Management — workspace-scoped forum channels
 *
 * Each forum channel maps to a workspace (project directory) on the host.
 * Channel naming: `crispy-{project}` where {project} is the basename of the
 * cwd. No PID suffix — on startup the bot wipes all existing crispy-*
 * channels and creates fresh ones.
 *
 * Zero coupling to watch state; depends only on discord-transport.
 *
 * @module message-view/forum
 */

import { log } from '../log.js';
import {
  createChannel,
  deleteChannel,
  getGuildChannels,
} from './discord-transport.js';

const SOURCE = 'message-view/forum';
const FORUM_ALLOW_BITS = '76864'; // VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY + MANAGE_MESSAGES + ADD_REACTIONS
const GUILD_FORUM = 15; // Discord channel type for forum channels
const GUILD_TEXT = 0;
const MAX_CHANNEL_NAME_LENGTH = 100;
const BOT_CHANNEL_PREFIX = 'crispy-bot-';

// ---------------------------------------------------------------------------
// Channel Naming
// ---------------------------------------------------------------------------

/**
 * Extract the project portion from a cwd.
 * `/home/user/dev/myproject` → `myproject`
 */
export function cwdToBaseProject(cwd: string): string {
  const segments = cwd.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'root';
}

/**
 * Build a workspace forum channel name: `crispy-{project}`.
 * No PID, no disambiguation — wipe-on-startup guarantees a clean slate.
 */
function buildChannelName(cwd: string): string {
  const project = cwdToBaseProject(cwd);
  const name = `crispy-${project}`;
  return name.length > MAX_CHANNEL_NAME_LENGTH
    ? name.slice(0, MAX_CHANNEL_NAME_LENGTH)
    : name;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceChannel {
  channelId: string;
  channelName: string;
  project: string;
}

// ---------------------------------------------------------------------------
// Wipe & Create — the only lifecycle strategy
// ---------------------------------------------------------------------------

/**
 * Delete ALL existing crispy-* channels (forums + bot channels) in the guild.
 * Called on startup to guarantee a clean slate.
 */
export async function wipeAllCrispyChannels(guildId: string): Promise<number> {
  const channels = await getGuildChannels(guildId);
  const crispyChannels = channels.filter(ch =>
    ch.name.startsWith('crispy-') && (ch.type === GUILD_FORUM || ch.type === GUILD_TEXT),
  );

  if (crispyChannels.length === 0) return 0;

  const results = await Promise.allSettled(
    crispyChannels.map(ch => deleteChannel(ch.id).catch(err => {
      log({ source: SOURCE, level: 'warn', summary: `failed to delete channel ${ch.name} (${ch.id})`, data: err });
    })),
  );

  const deleted = results.filter(r => r.status === 'fulfilled').length;
  log({ source: SOURCE, level: 'info', summary: `wiped ${deleted} crispy-* channel(s)` });
  return deleted;
}

/**
 * Create a fresh forum channel for a workspace.
 * Includes post guidelines so users know what to do.
 */
export async function createWorkspaceChannel(
  guildId: string,
  botId: string,
  ownerId: string | null,
  cwd: string,
): Promise<WorkspaceChannel> {
  const channelName = buildChannelName(cwd);
  const project = cwdToBaseProject(cwd);

  const permissionOverwrites: unknown[] = [
    { id: guildId, type: 0, deny: '1024' }, // deny @everyone VIEW_CHANNEL
    { id: botId, type: 1, allow: FORUM_ALLOW_BITS },
  ];
  if (ownerId) {
    permissionOverwrites.push({ id: ownerId, type: 1, allow: FORUM_ALLOW_BITS });
  }

  const forum = await createChannel(guildId, channelName, {
    type: GUILD_FORUM,
    topic: 'Start a new post to chat with Claude. Your post title becomes the conversation topic. Reply in the thread to continue.',
    permissionOverwrites,
  });

  log({ source: SOURCE, level: 'info', summary: `created workspace forum: ${channelName} (${forum.id})` });
  return { channelId: forum.id, channelName, project };
}

// ---------------------------------------------------------------------------
// Bot Channel
// ---------------------------------------------------------------------------

/**
 * Create a dedicated bot control channel: `#crispy-bot-{pid}`.
 * Private text channel for commands (!sessions, !status, etc.).
 */
export async function createBotChannel(
  guildId: string,
  botId: string,
  ownerId: string | null,
  pid: number,
): Promise<string> {
  const channelName = `${BOT_CHANNEL_PREFIX}${pid}`;

  const permissionOverwrites: unknown[] = [
    { id: guildId, type: 0, deny: '1024' },
    { id: botId, type: 1, allow: FORUM_ALLOW_BITS },
  ];
  if (ownerId) {
    permissionOverwrites.push({ id: ownerId, type: 1, allow: FORUM_ALLOW_BITS });
  }

  const channel = await createChannel(guildId, channelName, {
    type: GUILD_TEXT,
    permissionOverwrites,
  });

  log({ source: SOURCE, level: 'info', summary: `created bot channel: ${channelName} (${channel.id})` });
  return channel.id;
}
