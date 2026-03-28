/**
 * Bot Commands — ! command parsing and handlers
 *
 * Parses "!command args" from Discord messages in the bot control channel,
 * DMs, or @mentions. Primary entry point: `!sessions` for browsing and
 * opening recent conversations via emoji reactions.
 *
 * @module message-view/commands
 */

import { log } from '../log.js';
import {
  interruptSession,
  resolveSessionPrefix,
} from '../session-manager.js';
import { getActiveChannels } from '../session-channel.js';
import { sendMessage, sendMessageWithComponents } from './discord-transport.js';
import type { MessageComponent } from './discord-transport.js';
import type { AgentDispatch } from '../agent-dispatch-types.js';
import { listAllSessions } from '../session-manager.js';

const SOURCE = 'message-view/commands';
const COMMANDS_HELP = 'Available: `!sessions`, `!open`, `!stop`, `!status`';

// Active session list state — maps messageId → { sessions, page, channelId }
const activeSessionLists = new Map<string, {
  sessions: Array<{ sessionId: string; title: string }>;
  page: number;
  channelId: string;
}>();

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

  const needsForum = ['open', 'sessions'].includes(parsed.cmd);
  if (needsForum && !ctx.forumReady) {
    await sendMessage(channelId, '\u{274C} Forum channel not ready yet.').catch(() => {});
    return;
  }

  try {
    switch (parsed.cmd) {
      case 'sessions': return await handleSessions(channelId, parsed.args, ctx);
      case 'open':     return await handleOpen(channelId, parsed.args, ctx);
      case 'stop':     return await handleStop(channelId, parsed.args);
      case 'status':   return await handleStatus(channelId, ctx);
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

async function handleSessions(channelId: string, args: string, ctx: CommandContext): Promise<void> {
  const page = args ? Math.max(0, parseInt(args, 10) - 1) : 0;
  if (!Number.isFinite(page)) {
    await sendMessage(channelId, 'Usage: `!sessions` or `!sessions <page>`').catch(() => {});
    return;
  }

  const allSessions = listAllSessions();
  if (allSessions.length === 0) {
    await sendMessage(channelId, 'No sessions found.').catch(() => {});
    return;
  }

  const PAGE_SIZE = 10;
  const start = page * PAGE_SIZE;
  const pageSessions = allSessions.slice(start, start + PAGE_SIZE);

  if (pageSessions.length === 0) {
    await sendMessage(channelId, 'No more sessions.').catch(() => {});
    return;
  }

  const totalPages = Math.ceil(allSessions.length / PAGE_SIZE);
  const now = Date.now();

  // Pre-compute titles once — used in message text, button labels, and state storage
  const titles = pageSessions.map(s => s.title ?? s.label ?? '(untitled)');

  const lines = pageSessions.map((s, i) => {
    const ago = formatTimeAgo(now - s.modifiedAt.getTime());
    const vendor = s.vendor !== 'claude' ? ` \u{2022} ${s.vendor}` : '';
    return `**${i + 1}.** **${titles[i].slice(0, 55)}**  \u{2014}  ${ago}${vendor}`;
  });

  const header = totalPages > 1
    ? `\u{1F4C2} **Sessions** (page ${page + 1}/${totalPages})`
    : '\u{1F4C2} **Sessions**';

  // Build button rows (max 5 per action row)
  const buttons: MessageComponent[] = pageSessions.map((_s, i) => ({
    type: 2,
    style: 2,
    label: `${i + 1}. ${titles[i].slice(0, 70)}`,
    custom_id: `session:${i}`,
  }));

  const actionRows: MessageComponent[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    actionRows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }

  if (start + PAGE_SIZE < allSessions.length) {
    actionRows.push({
      type: 1,
      components: [{
        type: 2,
        style: 1,
        label: 'Next Page \u{25B6}',
        custom_id: `session_next:${page + 1}`,
      }],
    });
  }

  const msg = await sendMessageWithComponents(channelId, `${header}\n\n${lines.join('\n')}`, actionRows);

  activeSessionLists.set(msg.id, {
    sessions: pageSessions.map((s, i) => ({
      sessionId: s.sessionId,
      title: titles[i],
    })),
    page,
    channelId,
  });
}

function formatTimeAgo(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Handle a session pick button interaction.
 * Returns the picked session info, or null if the interaction is stale.
 */
export function handleSessionButtonPick(
  customId: string,
  messageId: string,
): { sessionId: string; title: string } | null {
  const state = activeSessionLists.get(messageId);
  if (!state) return null;
  const index = parseInt(customId.split(':')[1], 10);
  if (isNaN(index) || index >= state.sessions.length) return null;
  activeSessionLists.delete(messageId);
  return state.sessions[index];
}

/**
 * Handle a session list "Next Page" button interaction.
 * Posts the next page of sessions.
 */
export async function handleSessionNextButton(
  customId: string,
  messageId: string,
  ctx: CommandContext,
): Promise<void> {
  const state = activeSessionLists.get(messageId);
  if (!state) return;
  activeSessionLists.delete(messageId);
  const nextPage = parseInt(customId.split(':')[1], 10);
  if (isNaN(nextPage)) return;
  await handleSessions(state.channelId, String(nextPage + 1), ctx);
}

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

