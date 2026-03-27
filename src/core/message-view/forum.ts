/**
 * Forum Channel Management — workspace-scoped forum channels
 *
 * Each forum channel maps to a workspace (project directory) on the host.
 * Channel naming: `crispy-{project}-{pid}` where {project} is the basename
 * of the cwd and {pid} is the owning process ID. Bot control channels use
 * `crispy-bot-{pid}`. On startup each bot wipes its own PID channels and
 * health-checks other bots' channels — dead bots' channels get cleaned up,
 * live bots' channels are left alone.
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
 * Build a workspace forum channel name: `crispy-{project}-{pid}`.
 * PID suffix enables multiple Crispy instances on one Discord server.
 */
function buildChannelName(cwd: string, pid: number): string {
  const suffix = `-${pid}`;
  const prefix = 'crispy-';
  const maxProjectLen = MAX_CHANNEL_NAME_LENGTH - prefix.length - suffix.length;
  const project = cwdToBaseProject(cwd).slice(0, maxProjectLen);
  return `${prefix}${project}${suffix}`;
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
// Channel PID Parsing
// ---------------------------------------------------------------------------

interface ParsedChannelPid {
  pid: number;
  project?: string;
}

/**
 * Parse a crispy channel name to extract the PID.
 * - `crispy-bot-{pid}` → { pid }
 * - `crispy-{project}-{pid}` → { project, pid }
 * Returns null if the channel name doesn't match a crispy pattern with a PID.
 */
export function parseChannelPid(name: string): ParsedChannelPid | null {
  // Bot channel: crispy-bot-{pid}
  const botMatch = name.match(/^crispy-bot-(\d+)$/);
  if (botMatch) return { pid: parseInt(botMatch[1], 10) };

  // Forum channel: crispy-{project}-{pid} — greedy match on project, last numeric segment is PID
  const forumMatch = name.match(/^crispy-(.+)-(\d+)$/);
  if (forumMatch) return { project: forumMatch[1], pid: parseInt(forumMatch[2], 10) };

  return null;
}

// ---------------------------------------------------------------------------
// Selective Wipe — per-PID cleanup
// ---------------------------------------------------------------------------

type GuildChannel = { id: string; name: string; type: number };

function isCrispyChannel(ch: GuildChannel): boolean {
  return ch.name.startsWith('crispy-') && (ch.type === GUILD_FORUM || ch.type === GUILD_TEXT);
}

/** Delete channels matching a predicate. Accepts pre-fetched list to avoid redundant API calls. */
async function deleteMatchingChannels(
  channels: GuildChannel[],
  predicate: (parsed: ParsedChannelPid) => boolean,
  label: string,
): Promise<number> {
  const matching = channels.filter(ch => {
    if (!isCrispyChannel(ch)) return false;
    const parsed = parseChannelPid(ch.name);
    return parsed != null && predicate(parsed);
  });

  if (matching.length === 0) return 0;

  const results = await Promise.allSettled(
    matching.map(ch => deleteChannel(ch.id)),
  );

  let deleted = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      deleted++;
    } else {
      log({ source: SOURCE, level: 'warn', summary: `failed to delete channel ${matching[i].name} (${matching[i].id})`, data: (results[i] as PromiseRejectedResult).reason });
    }
  }
  log({ source: SOURCE, level: 'info', summary: `wiped ${deleted} channel(s) for ${label}` });
  return deleted;
}

/**
 * Scan guild channels and perform selective cleanup + discovery in one pass.
 * Returns { deletedOwn, otherBots } — own PID channels are deleted,
 * other bots' control channels are returned for health checking.
 */
export async function cleanupAndDiscoverBots(
  guildId: string,
  myPid: number,
): Promise<{
  deletedOwn: number;
  otherBots: Array<{ id: string; name: string; pid: number }>;
  channels: GuildChannel[];
}> {
  const channels = await getGuildChannels(guildId);

  // Wipe own PID channels
  const deletedOwn = await deleteMatchingChannels(channels, p => p.pid === myPid, `PID ${myPid}`);

  // Wipe legacy channels (pre-PID format: crispy-{project} with no PID suffix)
  const legacyChannels = channels.filter(ch =>
    isCrispyChannel(ch) && parseChannelPid(ch.name) === null,
  );
  if (legacyChannels.length > 0) {
    const legacyResults = await Promise.allSettled(legacyChannels.map(ch => deleteChannel(ch.id)));
    const legacyDeleted = legacyResults.filter(r => r.status === 'fulfilled').length;
    if (legacyDeleted > 0) {
      log({ source: SOURCE, level: 'info', summary: `wiped ${legacyDeleted} legacy crispy channel(s) (no PID)` });
    }
  }

  // Discover other bots' control channels
  const otherBots: Array<{ id: string; name: string; pid: number }> = [];
  for (const ch of channels) {
    if (ch.type !== GUILD_TEXT) continue;
    if (!ch.name.startsWith(BOT_CHANNEL_PREFIX)) continue;
    const parsed = parseChannelPid(ch.name);
    if (parsed && parsed.pid !== myPid) {
      otherBots.push({ id: ch.id, name: ch.name, pid: parsed.pid });
    }
  }

  return { deletedOwn, otherBots, channels };
}

/**
 * Bulk-delete all crispy channels whose PID is in the given set.
 * Accepts pre-fetched channel list to avoid redundant API calls.
 */
export async function wipeChannelsForPids(
  guildId: string,
  pids: Set<number>,
  prefetchedChannels?: GuildChannel[],
): Promise<number> {
  if (pids.size === 0) return 0;
  const channels = prefetchedChannels ?? await getGuildChannels(guildId);
  return deleteMatchingChannels(channels, p => pids.has(p.pid), `dead PIDs: ${[...pids].join(', ')}`);
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
  pid: number,
): Promise<WorkspaceChannel> {
  const channelName = buildChannelName(cwd, pid);
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
