/**
 * Bot Commands — ! command parsing and handlers
 *
 * Parses "!command args" from Discord DMs and @mentions.
 * Control-plane only: `!open`, `!stop`, `!status`, `!crispy`.
 * Session creation happens via user-created forum posts, not commands.
 *
 * @module message-view/commands
 */

import { hostname } from 'node:os';
import { log } from '../log.js';
import {
  interruptSession,
  resolveSessionPrefix,
} from '../session-manager.js';
import { getActiveChannels } from '../session-channel.js';
import { sendMessage } from './discord-transport.js';
import type { AgentDispatch } from '../agent-dispatch-types.js';

const SOURCE = 'message-view/commands';
const COMMANDS_HELP = 'Available: `!open`, `!stop`, `!status`, `!crispy`';

// ---------------------------------------------------------------------------
// Context interface — injected by discord-provider.ts
// ---------------------------------------------------------------------------

export interface CommandContext {
  readonly guildId: string | null;
  readonly forumReady: boolean;
  readonly permissionMode: string | null;
  readonly dispatch: AgentDispatch | null;
  uptimeMs(): number;
  watchedCount(): number;
  isWatching(sessionId: string): boolean;
  getWatchDiscordChannelId(sessionId: string): string | undefined;
  /** Open/watch a session. Optional forumChannelId scopes to a specific workspace forum. */
  openSession(sessionId: string, forumChannelId?: string): Promise<void>;
  /** Get the workspace cwd for a forum channel. */
  getWorkspaceCwd(forumChannelId: string | null): string | null;
  /** Number of active workspace forum channels. */
  workspaceCount(): number;
  /** Get session IDs currently tracked in Discord channelMap. */
  getTrackedSessionIds(): Set<string>;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseCommand(text: string): { cmd: string; args: string } | null {
  const match = text.match(/^!(\w+)\s*(.*)/s);
  if (!match) return null;
  return { cmd: match[1].toLowerCase(), args: match[2].trim() };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handleCommand(channelId: string, text: string, ctx: CommandContext): Promise<void> {
  const parsed = parseCommand(text);
  if (!parsed) {
    await sendMessage(channelId, `${COMMANDS_HELP}\nTo start a new session, create a forum post in a workspace channel.`).catch(() => {});
    return;
  }

  const needsForum = parsed.cmd === 'open';
  if (needsForum && !ctx.forumReady) {
    await sendMessage(channelId, '\u{274C} Forum channel not ready yet.').catch(() => {});
    return;
  }

  try {
    switch (parsed.cmd) {
      case 'open':   return await handleOpen(channelId, parsed.args, ctx);
      case 'stop':   return await handleStop(channelId, parsed.args);
      case 'status': return await handleStatus(channelId, ctx);
      case 'crispy':  return await handleCrispy(channelId, ctx);
      default:
        await sendMessage(channelId, `Unknown command: \`!${parsed.cmd}\`\n${COMMANDS_HELP}`).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(channelId, `\u{274C} Error: ${msg}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOpen(channelId: string, args: string, ctx: CommandContext): Promise<void> {
  if (!ctx.dispatch) {
    await sendMessage(channelId, '\u{274C} Dispatch not available.').catch(() => {});
    return;
  }

  if (args) {
    // Direct open by ID prefix
    const resolvedId = await ctx.dispatch.resolveSessionPrefix(args.trim());
    log({ source: SOURCE, level: 'info', summary: `open: resolved "${args.trim().slice(0, 12)}" -> "${resolvedId.slice(0, 12)}"` });

    if (ctx.isWatching(resolvedId)) {
      const discordChannelId = ctx.getWatchDiscordChannelId(resolvedId);
      const link = `https://discord.com/channels/${ctx.guildId}/${discordChannelId}`;
      await sendMessage(channelId, `Already watching: ${link}`).catch(() => {});
      return;
    }

    await ctx.openSession(resolvedId);
    const discordChannelId = ctx.getWatchDiscordChannelId(resolvedId);
    if (!discordChannelId) {
      await sendMessage(channelId, `\u{1F4E1} Session \`${resolvedId.slice(0, 8)}\` is being opened by another request.`).catch(() => {});
      return;
    }
    const link = `https://discord.com/channels/${ctx.guildId}/${discordChannelId}`;
    await sendMessage(channelId, `\u{1F4E1} Watching session \`${resolvedId.slice(0, 8)}\`\n${link}`).catch(() => {});
    return;
  }

  // List on-disk sessions not yet in Discord
  const sessions = await ctx.dispatch.listSessions();
  const inDiscord = ctx.getTrackedSessionIds();
  const available = sessions
    .filter(s => !inDiscord.has(s.sessionId))
    .slice(0, 10);

  if (available.length === 0) {
    await sendMessage(channelId, 'No additional sessions on disk.').catch(() => {});
    return;
  }

  const lines = available.map((s, i) =>
    `${i + 1}\u{FE0F}\u{20E3} ${(s.title ?? s.label ?? '(untitled)').slice(0, 60)} (\`${s.sessionId.slice(0, 8)}\`)`
  );
  await sendMessage(channelId, `\u{1F4C2} Sessions on disk:\n${lines.join('\n')}\n\nUse \`!open <id-prefix>\` to open one.`).catch(() => {});
}

async function handleStop(channelId: string, args: string): Promise<void> {
  const prefix = args.trim();
  if (!prefix) {
    await sendMessage(channelId, 'Usage: `!stop <session-id-prefix>`').catch(() => {});
    return;
  }

  const resolvedId = resolveSessionPrefix(prefix);
  await interruptSession(resolvedId);
  await sendMessage(channelId, `\u{1F6D1} Session \`${resolvedId.slice(0, 8)}\` interrupted.`).catch(() => {});
}

async function handleStatus(channelId: string, ctx: CommandContext): Promise<void> {
  const uptimeMin = Math.floor(ctx.uptimeMs() / 60000);
  const activeCount = getActiveChannels().length;
  const watched = ctx.watchedCount();
  const workspaces = ctx.workspaceCount();
  await sendMessage(
    channelId,
    `Uptime: ${uptimeMin}m\nWorkspaces: ${workspaces}\nActive channels: ${activeCount}\nWatched sessions: ${watched}`,
  ).catch(() => {});
}

async function handleCrispy(channelId: string, ctx: CommandContext): Promise<void> {
  const pid = process.pid;
  const uptimeMin = Math.floor(ctx.uptimeMs() / 60000);
  await sendMessage(
    channelId,
    `crispy-pong pid=${pid} host=${hostname()} uptime=${uptimeMin}m`,
  ).catch(() => {});
}
