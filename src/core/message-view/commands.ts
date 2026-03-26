/**
 * Bot Commands — ! command parsing and handlers
 *
 * Parses "!command args" from Discord DMs and @mentions.
 * Index module state is accessed via the CommandContext interface;
 * stateless queries (session list, active channels) are called directly.
 *
 * @module message-view/commands
 */

import { hostname } from 'node:os';
import { log } from '../log.js';
import {
  resolveSessionPrefix,
  listAllSessions,
  interruptSession,
  getRegisteredVendors,
} from '../session-manager.js';
import { getActiveChannels } from '../session-channel.js';
import type { Vendor } from '../transcript.js';
import { sendMessage } from './discord-transport.js';

const SOURCE = 'message-view/commands';

// ---------------------------------------------------------------------------
// Context interface — injected by index.ts
// ---------------------------------------------------------------------------

export interface CommandContext {
  readonly guildId: string | null;
  readonly forumReady: boolean;
  readonly permissionMode: string | null;
  uptimeMs(): number;
  watchedCount(): number;
  isWatching(sessionId: string): boolean;
  getWatchDiscordChannelId(sessionId: string): string | undefined;
  /** Returns false if at concurrency limit. */
  acquirePromptSlot(): boolean;
  releasePromptSlot(): void;
  createSession(vendor: Vendor, prompt: string): Promise<{ sessionId: string; discordChannelId: string }>;
  openSession(sessionId: string): Promise<void>;
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
    await sendMessage(channelId, 'Use `!new`, `!open`, `!sessions`, `!stop`, `!status`, or `!crispy`').catch(() => {});
    return;
  }

  const needsForum = parsed.cmd === 'new' || parsed.cmd === 'open';
  if (needsForum && !ctx.forumReady) {
    await sendMessage(channelId, '\u{274C} Forum channel not ready yet.').catch(() => {});
    return;
  }

  try {
    switch (parsed.cmd) {
      case 'new':    return await handleNew(channelId, parsed.args, ctx);
      case 'open':   return await handleOpen(channelId, parsed.args, ctx);
      case 'sessions': return await handleSessions(channelId);
      case 'stop':   return await handleStop(channelId, parsed.args);
      case 'status': return await handleStatus(channelId, ctx);
      case 'crispy':  return await handleCrispy(channelId, ctx);
      default:
        await sendMessage(channelId, `Unknown command: \`!${parsed.cmd}\``).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(channelId, `\u{274C} Error: ${msg}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleNew(channelId: string, args: string, ctx: CommandContext): Promise<void> {
  const registeredVendors = getRegisteredVendors();
  let vendor: Vendor = registeredVendors.size === 1
    ? [...registeredVendors][0]
    : 'claude';
  let prompt = args;
  const firstWord = args.split(/\s+/)[0]?.toLowerCase();
  if (firstWord && registeredVendors.has(firstWord)) {
    vendor = firstWord;
    prompt = args.slice(firstWord.length).trim();
  }

  if (!prompt) {
    await sendMessage(channelId, 'Usage: `!new [vendor] <prompt>`').catch(() => {});
    return;
  }

  if (!ctx.acquirePromptSlot()) {
    await sendMessage(channelId, '\u{274C} Too many sessions starting concurrently -- try again in a moment.').catch(() => {});
    return;
  }

  try {
    const result = await ctx.createSession(vendor, prompt);
    const link = `https://discord.com/channels/${ctx.guildId}/${result.discordChannelId}`;
    await sendMessage(channelId, `\u{2705} Session \`${result.sessionId.slice(0, 8)}\` created\n${link}`).catch(() => {});
  } finally {
    ctx.releasePromptSlot();
  }
}

async function handleOpen(channelId: string, args: string, ctx: CommandContext): Promise<void> {
  const prefix = args.trim();
  if (!prefix) {
    await sendMessage(channelId, 'Usage: `!open <session-id-prefix>`').catch(() => {});
    return;
  }

  const resolvedId = resolveSessionPrefix(prefix);
  log({ source: SOURCE, level: 'info', summary: `open: resolved "${prefix.slice(0, 12)}" -> "${resolvedId.slice(0, 12)}"` });

  if (ctx.isWatching(resolvedId)) {
    const discordChannelId = ctx.getWatchDiscordChannelId(resolvedId);
    const link = `https://discord.com/channels/${ctx.guildId}/${discordChannelId}`;
    await sendMessage(channelId, `Already watching: ${link}`).catch(() => {});
    return;
  }

  await ctx.openSession(resolvedId);
  const discordChannelId = ctx.getWatchDiscordChannelId(resolvedId);
  if (!discordChannelId) {
    // Concurrent !open: another call is still setting up the watch.
    await sendMessage(channelId, `\u{1F4E1} Session \`${resolvedId.slice(0, 8)}\` is being opened by another request.`).catch(() => {});
    return;
  }
  const link = `https://discord.com/channels/${ctx.guildId}/${discordChannelId}`;
  await sendMessage(channelId, `\u{1F4E1} Watching session \`${resolvedId.slice(0, 8)}\`\n${link}`).catch(() => {});
}

async function handleSessions(channelId: string): Promise<void> {
  const allSessions = listAllSessions();
  const recent = allSessions
    .filter(s => s.sessionKind !== 'system')
    .slice(0, 10);

  if (recent.length === 0) {
    await sendMessage(channelId, 'No sessions found.').catch(() => {});
    return;
  }

  const lines: string[] = [];
  for (const s of recent) {
    const prefix = s.sessionId.slice(0, 8);
    const title = (s.title ?? s.label ?? '(untitled)').slice(0, 60);
    const ago = formatRelativeTime(s.modifiedAt);
    const active = getActiveChannels().some(ch => ch.channelId === s.sessionId) ? ' [active]' : '';
    lines.push(`\`${prefix}\` | ${s.vendor} | ${title} (${ago})${active}`);
  }
  await sendMessage(channelId, `**Recent sessions (${lines.length}):**\n${lines.join('\n')}`).catch(() => {});
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
  const allSessions = listAllSessions().filter(s => s.sessionKind !== 'system');
  await sendMessage(
    channelId,
    `Uptime: ${uptimeMin}m\nActive channels: ${activeCount}\nWatched sessions: ${watched}\nTotal sessions: ${allSessions.length}`,
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}
