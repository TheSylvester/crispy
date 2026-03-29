/**
 * Bot Commands — ! command parsing and handlers
 *
 * Parses "!command args" from Discord messages in the bot control channel,
 * DMs, or @mentions. Primary entry point: `!sessions` for browsing and
 * opening recent conversations via button interactions.
 *
 * @module message-view/commands
 */

import { log } from '../log.js';
import {
  interruptSession,
  resolveSessionPrefix,
} from '../session-manager.js';
import { getActiveChannels } from '../session-channel.js';
import {
  sendMessage,
  sendMessageWithComponents,
  editMessageWithComponents,
  deleteMessage,
  getMessages,
  bulkDeleteMessages,
} from './discord-transport.js';
import type { MessageComponent } from './discord-transport.js';
import type { AgentDispatch } from '../agent-dispatch-types.js';
import { listAllSessions } from '../session-manager.js';

const SOURCE = 'message-view/commands';
const COMMANDS_HELP = 'Available: `!sessions`, `!open`, `!stop`, `!status`';

/** Sessions per page: 5 in msg1 + 4 in msg2 (+ Next Page button). */
const MSG1_SLOTS = 5;
const MSG2_SLOTS = 4;
const PAGE_SIZE = MSG1_SLOTS + MSG2_SLOTS; // 9

/** Auto-refresh the session screen after this many ms of inactivity. */
const SCREEN_IDLE_REFRESH_MS = 60_000;

// Session display — mirrors webview/utils/session-display.ts (can't import from webview layer)
function getSessionDisplayName(s: { title?: string; label?: string; lastUserPrompt?: string; sessionId: string }): string {
  return s.title?.trim() || s.lastUserPrompt?.trim() || s.label?.trim() || s.sessionId.slice(0, 8) + '\u{2026}';
}

// ---------------------------------------------------------------------------
// Session screen state — the bot channel is treated as an interactive display.
// Each channel has at most one "screen" (2 Discord messages) that is edited
// in-place for pagination and auto-refreshed after idle.
// ---------------------------------------------------------------------------

interface SessionScreen {
  channelId: string;
  /** Discord message IDs for the two screen messages. */
  messageIds: [string, string] | [string];
  /** Session data visible on the current page (for button→session mapping). */
  sessions: Array<{ sessionId: string; title: string }>;
  page: number;
  lastInteraction: number;
  refreshTimer: ReturnType<typeof setTimeout> | null;
}

/** One screen per bot control channel. */
const activeScreens = new Map<string, SessionScreen>();

/**
 * Look up a session from a button click on any screen message.
 * Matches against both message IDs in the screen.
 */
export function getScreenForMessage(messageId: string): SessionScreen | undefined {
  for (const screen of activeScreens.values()) {
    if (screen.messageIds.includes(messageId)) return screen;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Context interface — injected by discord-provider.ts
// ---------------------------------------------------------------------------

export interface CommandContext {
  readonly guildId: string | null;
  readonly permissionMode: string | null;
  readonly dispatch: AgentDispatch | null;
  /** The toolbar message ID in the bot channel (preserved during wipes). */
  readonly toolbarMessageId: string | null;
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

  const start = page * PAGE_SIZE;
  const pageSessions = allSessions.slice(start, start + PAGE_SIZE);

  if (pageSessions.length === 0) {
    await sendMessage(channelId, 'No more sessions.').catch(() => {});
    return;
  }

  const totalPages = Math.ceil(allSessions.length / PAGE_SIZE);
  const displayNames = pageSessions.map(s => getSessionDisplayName(s));

  const header = totalPages > 1
    ? `\u{1F4C2} **Sessions** (page ${page + 1}/${totalPages})`
    : '\u{1F4C2} **Sessions**';

  const hasNextPage = start + PAGE_SIZE < allSessions.length;

  // Split sessions across two messages: msg1 gets up to MSG1_SLOTS, msg2 gets the rest.
  // msg2 is only used when there are >MSG1_SLOTS sessions or a Next Page button is needed.
  const msg1Names = displayNames.slice(0, MSG1_SLOTS);
  const msg2Names = displayNames.slice(MSG1_SLOTS);
  const needsMsg2 = msg2Names.length > 0 || hasNextPage;

  // Build vertical-stack action rows (1 button per row)
  const buildRows = (names: string[], offset: number): MessageComponent[] =>
    names.map((name, i) => ({
      type: 1 as const,
      components: [{
        type: 2 as const,
        style: 2 as const,
        label: name.slice(0, 80),
        custom_id: `session:${offset + i}`,
      }],
    }));

  const msg1Rows = buildRows(msg1Names, 0);

  // If ≤5 sessions and no next page, put Next Page on msg1 (won't exceed 5 rows)
  if (hasNextPage && !needsMsg2) {
    msg1Rows.push({
      type: 1,
      components: [{
        type: 2,
        style: 1,
        label: 'Next Page \u{25B6}',
        custom_id: `session_next:${page + 1}`,
      }],
    });
  }

  let msg2Rows: MessageComponent[] = [];
  if (needsMsg2) {
    msg2Rows = buildRows(msg2Names, MSG1_SLOTS);
    if (hasNextPage) {
      msg2Rows.push({
        type: 1,
        components: [{
          type: 2,
          style: 1,
          label: 'Next Page \u{25B6}',
          custom_id: `session_next:${page + 1}`,
        }],
      });
    }
  }

  // Check for existing screen to edit-in-place
  const existing = activeScreens.get(channelId);

  const sessionData = pageSessions.map((s, i) => ({
    sessionId: s.sessionId,
    title: displayNames[i],
  }));

  if (existing) {
    try {
      await editMessageWithComponents(channelId, existing.messageIds[0], header, msg1Rows);
      if (existing.messageIds.length === 2 && needsMsg2) {
        // Edit existing msg2
        await editMessageWithComponents(channelId, existing.messageIds[1], '\u{200B}', msg2Rows);
      } else if (existing.messageIds.length === 2 && !needsMsg2) {
        // Had msg2 but no longer needed — delete it
        deleteMessage(channelId, existing.messageIds[1]).catch(() => {});
        existing.messageIds = [existing.messageIds[0]];
      } else if (existing.messageIds.length === 1 && needsMsg2) {
        // Need msg2 but didn't have one — create it
        const msg2 = await sendMessageWithComponents(channelId, '\u{200B}', msg2Rows);
        existing.messageIds = [existing.messageIds[0], msg2.id];
      }
      existing.sessions = sessionData;
      existing.page = page;
      existing.lastInteraction = Date.now();
      scheduleScreenRefresh(channelId, ctx);
      return;
    } catch {
      // Edit failed (messages deleted?) — fall through to create new
      teardownScreen(channelId);
    }
  }

  // Create fresh screen
  const msg1 = await sendMessageWithComponents(channelId, header, msg1Rows);
  const messageIds: [string, string] | [string] = needsMsg2
    ? [msg1.id, (await sendMessageWithComponents(channelId, '\u{200B}', msg2Rows)).id]
    : [msg1.id];

  const screen: SessionScreen = {
    channelId,
    messageIds,
    sessions: sessionData,
    page,
    lastInteraction: Date.now(),
    refreshTimer: null,
  };
  activeScreens.set(channelId, screen);
  scheduleScreenRefresh(channelId, ctx);
}

/**
 * Handle a session pick button interaction.
 * Returns the picked session info, or null if the interaction is stale.
 */
export function handleSessionButtonPick(
  customId: string,
  messageId: string,
): { sessionId: string; title: string } | null {
  const screen = getScreenForMessage(messageId);
  if (!screen) return null;
  const index = parseInt(customId.split(':')[1], 10);
  if (isNaN(index) || index >= screen.sessions.length) return null;
  screen.lastInteraction = Date.now();
  return screen.sessions[index];
}

/**
 * Handle a session list "Next Page" button interaction.
 * Edits the screen in-place to show the next page.
 */
export async function handleSessionNextButton(
  customId: string,
  messageId: string,
  ctx: CommandContext,
): Promise<void> {
  const screen = getScreenForMessage(messageId);
  if (!screen) return;
  const nextPage = parseInt(customId.split(':')[1], 10);
  if (isNaN(nextPage)) return;
  await handleSessions(screen.channelId, String(nextPage + 1), ctx);
}

// ---------------------------------------------------------------------------
// Screen lifecycle
// ---------------------------------------------------------------------------

function scheduleScreenRefresh(channelId: string, ctx: CommandContext): void {
  const screen = activeScreens.get(channelId);
  if (!screen) return;

  if (screen.refreshTimer) clearTimeout(screen.refreshTimer);
  screen.refreshTimer = setTimeout(async () => {
    const current = activeScreens.get(channelId);
    if (!current || current !== screen) return;
    // Postpone if a recent interaction happened within the idle window
    const elapsed = Date.now() - current.lastInteraction;
    if (elapsed < SCREEN_IDLE_REFRESH_MS) {
      scheduleScreenRefresh(channelId, ctx);
      return;
    }
    // Idle wipe: delete all non-toolbar messages, then re-render session list
    try {
      await wipeNonToolbarMessages(channelId, ctx.toolbarMessageId);
      if (screen.refreshTimer) clearTimeout(screen.refreshTimer);
      activeScreens.delete(channelId);
      await handleSessions(channelId, '1', ctx);
    } catch (err) {
      log({ source: SOURCE, level: 'warn', summary: 'session screen idle wipe failed', data: err });
    }
  }, SCREEN_IDLE_REFRESH_MS);
}

function teardownScreen(channelId: string): void {
  const screen = activeScreens.get(channelId);
  if (!screen) return;
  if (screen.refreshTimer) clearTimeout(screen.refreshTimer);
  // Best-effort delete old messages
  for (const msgId of screen.messageIds) {
    deleteMessage(channelId, msgId).catch(() => {});
  }
  activeScreens.delete(channelId);
}

/** Clean up all screens (called on bot shutdown). */
export function disposeAllScreens(): void {
  for (const screen of activeScreens.values()) {
    if (screen.refreshTimer) clearTimeout(screen.refreshTimer);
  }
  activeScreens.clear();
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

// ---------------------------------------------------------------------------
// Channel Wipe — delete all non-toolbar messages
// ---------------------------------------------------------------------------

/**
 * Delete all messages in a channel except the toolbar message.
 * Paginates through `getMessages()` (max 100 per call) until all
 * non-toolbar messages are deleted.
 */
async function wipeNonToolbarMessages(channelId: string, toolbarId: string | null): Promise<void> {
  let deleted = 0;
  const MAX_PAGES = 5;

  for (let page = 0; page < MAX_PAGES; page++) {
    const messages = await getMessages(channelId, { limit: 100 });
    if (messages.length === 0) break;

    const toDelete = messages.filter(m => m.id !== toolbarId).map(m => m.id);
    if (toDelete.length === 0) break;

    try {
      await bulkDeleteMessages(channelId, toDelete);
    } catch {
      // Bulk delete can fail for messages >14 days old — fall back to individual deletes
      await Promise.allSettled(toDelete.map(id => deleteMessage(channelId, id)));
    }
    deleted += toDelete.length;

    if (messages.length < 100) break;
  }

  if (deleted > 0) {
    log({ source: SOURCE, level: 'info', summary: `wiped ${deleted} message(s) from channel ${channelId}` });
  }
}

/**
 * Reset the bot channel: wipe all non-toolbar messages, tear down the
 * existing screen, and re-render the session list from scratch.
 */
export async function resetBotChannel(
  channelId: string,
  ctx: CommandContext,
): Promise<void> {
  const existing = activeScreens.get(channelId);
  if (existing) {
    if (existing.refreshTimer) clearTimeout(existing.refreshTimer);
    activeScreens.delete(channelId);
  }

  await wipeNonToolbarMessages(channelId, ctx.toolbarMessageId);
  await handleSessions(channelId, '1', ctx);
}

