/**
 * Forum Channel Management — workspace-scoped forum channels, claiming, and thread rejoin
 *
 * Each forum channel maps to a workspace (project directory) on the host.
 * Channel naming: `crispy-{project}-{pid}` where {project} is the basename
 * of the cwd (with parent segments added for disambiguation) and {pid} is
 * the owning process PID.
 *
 * Zero coupling to watch state; depends only on discord-transport.
 *
 * @module message-view/forum
 */

import { log } from '../log.js';
import {
  discordFetch,
  createChannel,
  deleteChannel,
  createForumPost,
  getGuildChannels,
  getActiveThreads,
} from './discord-transport.js';

const SOURCE = 'message-view/forum';
const FORUM_ALLOW_BITS = '76864'; // VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY + MANAGE_MESSAGES + ADD_REACTIONS
const GUILD_FORUM = 15; // Discord channel type for forum channels
const MAX_CHANNEL_NAME_LENGTH = 100; // Discord channel name limit

// ---------------------------------------------------------------------------
// Channel Naming
// ---------------------------------------------------------------------------

/**
 * Build a workspace forum channel name: `crispy-{project}-{pid}`.
 *
 * The project portion is the basename of cwd, with parent path segments
 * prepended if needed to disambiguate from other crispy-* channels.
 */
export function buildWorkspaceChannelName(
  cwd: string,
  pid: number,
  existingNames: string[],
): string {
  const segments = cwd.split('/').filter(Boolean).reverse(); // e.g. ['crispy', 'dev', 'silver', 'home']
  if (segments.length === 0) return `crispy-root-${pid}`;

  let project = segments[0];

  // Pre-parse all existing channel names once to avoid re-parsing per iteration
  const existingProjects = new Set(
    existingNames.map(n => parseWorkspaceChannelName(n)?.project).filter(Boolean) as string[],
  );

  // Add parent segments until unique among other crispy-* channels
  for (let i = 1; i < segments.length; i++) {
    const candidate = `crispy-${project}-${pid}`;
    // A collision exists if another channel has the same project portion but isn't our own name
    const collision = existingProjects.has(project) &&
      existingNames.some(name => name !== candidate && parseWorkspaceChannelName(name)?.project === project);
    if (!collision) break;
    project = `${segments[i]}-${project}`;
  }

  // Truncate project portion if the full name would exceed Discord's limit
  const suffix = `-${pid}`;
  const prefix = 'crispy-';
  const maxProjectLen = MAX_CHANNEL_NAME_LENGTH - prefix.length - suffix.length;
  if (project.length > maxProjectLen) {
    project = project.slice(0, maxProjectLen);
  }

  return `crispy-${project}-${pid}`;
}

/**
 * Parse a workspace channel name into its project and PID components.
 *
 * Uses greedy `.+` so multi-hyphen project names parse correctly:
 * `crispy-work-api-12345` → { project: 'work-api', pid: 12345 }
 */
export function parseWorkspaceChannelName(name: string): { project: string; pid: number } | null {
  const match = name.match(/^crispy-(.+)-(\d+)$/);
  if (!match) return null;
  return { project: match[1], pid: parseInt(match[2], 10) };
}

/**
 * Extract the project portion from a cwd for matching against existing channels.
 * Mirrors the base case of buildWorkspaceChannelName (before disambiguation).
 */
export function cwdToBaseProject(cwd: string): string {
  const segments = cwd.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'root';
}

// ---------------------------------------------------------------------------
// Channel Claiming (Three-Way Tiebreaker)
// ---------------------------------------------------------------------------

/**
 * Attempt to claim an existing forum channel by renaming it with our PID.
 *
 * Three-way tiebreaker:
 * - PATCH rename to myName → GET back → check current name:
 *   - My PID → won
 *   - Old name (unchanged) → retry (my PATCH failed)
 *   - Different new PID → lost (someone else claimed it)
 */
export async function claimChannel(
  channelId: string,
  myName: string,
  oldName: string,
): Promise<'won' | 'retry' | 'lost'> {
  try {
    await discordFetch('PATCH', `/channels/${channelId}`, { name: myName });
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: `claim PATCH failed for ${channelId}`, data: err });
    return 'retry';
  }

  const channel = await discordFetch('GET', `/channels/${channelId}`) as { name: string };
  const currentName = channel.name;

  if (currentName === myName) return 'won';
  if (currentName === oldName) return 'retry';
  return 'lost';
}

// ---------------------------------------------------------------------------
// Workspace Channel Lifecycle
// ---------------------------------------------------------------------------

export interface WorkspaceChannel {
  channelId: string;
  channelName: string;
  project: string;
}

/**
 * Scan guild for existing crispy-* forum channels.
 */
export async function scanWorkspaceChannels(
  guildId: string,
): Promise<Array<{ id: string; name: string; project: string; pid: number }>> {
  const channels = await getGuildChannels(guildId);
  const results: Array<{ id: string; name: string; project: string; pid: number }> = [];

  for (const ch of channels) {
    if (ch.type !== GUILD_FORUM) continue;
    const parsed = parseWorkspaceChannelName(ch.name);
    if (!parsed) continue;
    results.push({ id: ch.id, name: ch.name, project: parsed.project, pid: parsed.pid });
  }

  return results;
}

/**
 * Ensure a forum channel exists for a workspace. Creates if not found,
 * claims (renames) if found with a different PID.
 *
 * Returns the channel ID or null if claiming was lost to another instance.
 */
export async function ensureWorkspaceChannel(
  guildId: string,
  botId: string,
  ownerId: string | null,
  cwd: string,
  pid: number,
  existingForums: Array<{ id: string; name: string; project: string; pid: number }>,
): Promise<WorkspaceChannel | null> {
  const baseProject = cwdToBaseProject(cwd);

  // Match existing channel for this workspace using the base project name.
  // Check both exact match and disambiguated forms (e.g. "dev-crispy" ends with "-crispy").
  // This must happen BEFORE buildWorkspaceChannelName, which would re-disambiguate and
  // produce a name that no longer matches the existing channel — causing a duplicate.
  const existing = existingForums.find(f => f.project === baseProject)
    ?? existingForums.find(f => f.project.endsWith(`-${baseProject}`));

  // When reusing an existing channel, preserve its project portion (keeps disambiguation stable).
  // Only call buildWorkspaceChannelName for genuinely new channels.
  const existingNames = existingForums.map(f => f.name);
  const myChannelName = existing
    ? `crispy-${existing.project}-${pid}`
    : buildWorkspaceChannelName(cwd, pid, existingNames);
  const myProject = parseWorkspaceChannelName(myChannelName)!.project;

  if (existing) {
    if (existing.pid === pid) {
      // Already ours (e.g. reconnect after Gateway drop)
      await repairForumPermissions(existing.id, guildId, botId, ownerId);
      return { channelId: existing.id, channelName: existing.name, project: myProject };
    }

    // Claim from previous owner — three-way tiebreaker
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const result = await claimChannel(existing.id, myChannelName, existing.name);
      if (result === 'won') {
        await repairForumPermissions(existing.id, guildId, botId, ownerId);
        log({ source: SOURCE, level: 'info', summary: `claimed workspace channel ${myChannelName} (was ${existing.name})` });
        return { channelId: existing.id, channelName: myChannelName, project: myProject };
      }
      if (result === 'lost') {
        log({ source: SOURCE, level: 'warn', summary: `lost claim for workspace channel ${myChannelName} — another instance won` });
        return null;
      }
      // result === 'retry' — try again
      log({ source: SOURCE, level: 'debug', summary: `claim retry ${attempt + 1} for ${myChannelName}` });
    }

    log({ source: SOURCE, level: 'warn', summary: `exhausted claim retries for ${myChannelName}` });
    return null;
  }

  // No existing channel — create new
  const permissionOverwrites: unknown[] = [
    { id: guildId, type: 0, deny: '1024' },
    { id: botId, type: 1, allow: FORUM_ALLOW_BITS },
  ];
  if (ownerId) {
    permissionOverwrites.push({ id: ownerId, type: 1, allow: FORUM_ALLOW_BITS });
  }

  const forum = await createChannel(guildId, myChannelName, {
    type: GUILD_FORUM,
    permissionOverwrites,
  });
  log({ source: SOURCE, level: 'info', summary: `created workspace forum channel: ${myChannelName} (${forum.id})` });
  return { channelId: forum.id, channelName: myChannelName, project: myProject };
}

/**
 * Take over other crispy-* channels whose PIDs are dead.
 * Renames them with our PID to signal ownership transfer.
 *
 * Returns the channels we successfully took over.
 */
export async function takeOverOrphanedChannels(
  pid: number,
  existingForums: Array<{ id: string; name: string; project: string; pid: number }>,
  ownedChannelIds: Set<string>,
): Promise<WorkspaceChannel[]> {
  const candidates = existingForums.filter(f =>
    !ownedChannelIds.has(f.id) && f.pid !== pid && !isProcessAlive(f.pid),
  );

  const results = await Promise.allSettled(candidates.map(async (forum) => {
    const newName = `crispy-${forum.project}-${pid}`;
    const result = await claimChannel(forum.id, newName, forum.name);
    if (result === 'won') {
      log({ source: SOURCE, level: 'info', summary: `took over orphaned channel ${forum.name} → ${newName}` });
      return { channelId: forum.id, channelName: newName, project: forum.project } satisfies WorkspaceChannel;
    }
    if (result === 'lost') {
      log({ source: SOURCE, level: 'debug', summary: `lost orphan claim for ${forum.name} — another instance won` });
    }
    return null;
  }));

  const takenOver: WorkspaceChannel[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) takenOver.push(result.value);
    else if (result.status === 'rejected') log({ source: SOURCE, level: 'warn', summary: 'failed to take over orphaned channel', data: result.reason });
  }
  return takenOver;
}

/**
 * Check if a process is still alive (best-effort, POSIX only).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Thread Management
// ---------------------------------------------------------------------------

export async function rejoinForumThreads(guildId: string, forumId: string): Promise<Array<{ id: string; name: string; parent_id: string }>> {
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
  if (allThreads.length === 0) return activeForum;

  const joinTasks = allThreads.map(t =>
    discordFetch('PUT', `/channels/${t.id}/thread-members/@me`).catch((err) => {
      log({ source: SOURCE, level: 'debug', summary: `failed to join thread ${t.id}`, data: err });
    })
  );
  await Promise.all(joinTasks);
  log({ source: SOURCE, level: 'info', summary: `re-joined ${allThreads.length} forum thread${allThreads.length > 1 ? 's' : ''} (${activeForum.length} active, ${archivedForum.length} archived)` });
  return activeForum;
}

// ---------------------------------------------------------------------------
// Bot Channel — dedicated top-level text channel for health/leadership probes
// ---------------------------------------------------------------------------

const GUILD_TEXT = 0; // Discord channel type for text channels
const BOT_CHANNEL_PREFIX = 'crispy-bot-';

/**
 * Ensure a dedicated bot health channel exists: `#crispy-bot-{pid}`.
 * Creates a private text channel with the same permission overwrites as forum channels.
 */
export async function ensureBotChannel(
  guildId: string,
  botId: string,
  ownerId: string | null,
  pid: number,
): Promise<string> {
  const channelName = `${BOT_CHANNEL_PREFIX}${pid}`;

  // Check if our channel already exists
  const existing = await findBotChannels(guildId);
  const mine = existing.find(ch => ch.pid === pid);
  if (mine) return mine.id;

  // Create new text channel with restricted permissions
  const permissionOverwrites: unknown[] = [
    { id: guildId, type: 0, deny: '1024' }, // deny @everyone VIEW_CHANNEL
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

/**
 * Scan guild for existing `#crispy-bot-*` text channels, parsing PID from name.
 */
export async function findBotChannels(
  guildId: string,
): Promise<Array<{ id: string; name: string; pid: number }>> {
  const channels = await getGuildChannels(guildId);
  const results: Array<{ id: string; name: string; pid: number }> = [];

  for (const ch of channels) {
    if (ch.type !== GUILD_TEXT) continue;
    if (!ch.name.startsWith(BOT_CHANNEL_PREFIX)) continue;
    const pidStr = ch.name.slice(BOT_CHANNEL_PREFIX.length);
    const pid = parseInt(pidStr, 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    results.push({ id: ch.id, name: ch.name, pid });
  }

  return results;
}

/**
 * Delete a stale bot channel (crashed instance cleanup).
 */
export async function deleteBotChannel(channelId: string): Promise<void> {
  await deleteChannel(channelId);
  log({ source: SOURCE, level: 'info', summary: `deleted stale bot channel: ${channelId}` });
}

// ---------------------------------------------------------------------------
// Permission Repair
// ---------------------------------------------------------------------------

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
