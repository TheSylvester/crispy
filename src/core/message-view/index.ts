/**
 * Message View — Forum-post-based Discord bot orchestration
 *
 * Lifecycle management, Gateway routing, watch state, sync loop, and approval
 * flow. Rendering is in render.ts; command handling is in commands.ts.
 *
 * @module message-view/index
 */

import { readFileSync } from 'node:fs';
import { log } from '../log.js';
import { onSettingsChanged } from '../settings/index.js';
import { settingsPath } from '../paths.js';
import { subscribeSession, sendTurn } from '../session-manager.js';
import { subscribeSessionList, unsubscribeSessionList } from '../session-list-manager.js';
import type { SessionListSubscriber } from '../session-list-manager.js';
import type { SessionListEvent } from '../session-list-events.js';
import { unsubscribe, resolveApproval } from '../session-channel.js';
import type { Subscriber, SubscriberMessage, SessionChannel } from '../session-channel.js';
import type { TranscriptEntry, Vendor } from '../transcript.js';
import type { ApprovalOption, PendingApprovalInfo } from '../channel-events.js';
import type { TurnIntent } from '../agent-adapter.js';
import {
  initTransport,
  shutdownTransport,
  sendMessage,
  editMessage,
  addReaction,
  createChannel,
  createForumPost,
  archiveThread,
  connectGateway,
  disconnectGateway,
  getBotUserId,
  getGuildChannels,
  discordFetch,
  triggerTyping,
  getActiveThreads,
} from './discord-transport.js';
import type { GatewayEventHandler } from './discord-transport.js';
import type { DiscordProviderConfig, MessageProviderConfig } from './config.js';
import { renderSession, getStatusLine, truncate, DISCORD_MAX_LENGTH } from './render.js';
import type { WatchStatus } from './render.js';
import { handleCommand } from './commands.js';
import type { CommandContext } from './commands.js';

// Re-export pure functions for testing
export { renderSession, splitAtNewlines } from './render.js';

const SOURCE = 'message-view';
const MAX_CONCURRENT_PROMPTS = 3;
const MIN_PROMPT_LENGTH = 3;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let activeConfig: DiscordProviderConfig | null = null;
let unsubSettings: (() => void) | null = null;
let unsubSessionList: (() => void) | null = null;
let startTime: number = 0;
let promptsInFlight = 0;
let forumChannelId: string | null = null;
let ownerUserId: string | null = null;

// ---------------------------------------------------------------------------
// Watch state
// ---------------------------------------------------------------------------

interface PendingInteraction {
  discordMessageId: string;
  toolUseId: string;
  toolName: string;
  options: ApprovalOption[];
  emojiToOptionId: Map<string, string>;
}

interface WatchState {
  sessionId: string;
  discordChannelId: string;
  subscriber: Subscriber;
  /** Null until subscribeSession completes (pre-registered for catchup delivery). */
  channel: SessionChannel | null;
  entries: TranscriptEntry[];
  toolResults: Map<string, boolean>;
  messageIds: string[];
  currentChunks: string[];
  dirty: boolean;
  pendingInteractions: Map<string, PendingInteraction>;
  /** True while syncSession is in-flight (prevents concurrent syncs). */
  syncing: boolean;
  status: WatchStatus;
}

const watchedSessions = new Map<string, WatchState>();
const channelToSession = new Map<string, string>();
const commandSessionIds = new Set<string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initMessageView(): void {
  const config = findEnabledDiscordProvider();
  if (!config) {
    log({ source: SOURCE, level: 'info', summary: 'no enabled discord provider found -- skipping init' });
    return;
  }

  startUp(config);

  unsubSettings = onSettingsChanged(() => {
    const next = findEnabledDiscordProvider();
    if (!next) {
      if (activeConfig) tearDown();
      return;
    }
    if (activeConfig && (next.token !== activeConfig.token || next.guildId !== activeConfig.guildId)) {
      tearDown();
      startUp(next);
    } else if (!activeConfig) {
      startUp(next);
    }
  });
}

export function shutdownMessageView(): void {
  if (unsubSettings) {
    unsubSettings();
    unsubSettings = null;
  }
  tearDown();
}

// ---------------------------------------------------------------------------
// Startup / Teardown
// ---------------------------------------------------------------------------

function findEnabledDiscordProvider(): DiscordProviderConfig | null {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    const providers = raw.messageProviders as MessageProviderConfig[] | undefined;
    if (!providers) return null;
    return providers.find((p: MessageProviderConfig) => p.type === 'discord' && p.enabled) ?? null;
  } catch {
    return null;
  }
}

function startUp(config: DiscordProviderConfig): void {
  activeConfig = config;
  startTime = Date.now();
  promptsInFlight = 0;
  forumChannelId = null;
  ownerUserId = null;
  initTransport(config.token);

  log({ source: SOURCE, level: 'info', summary: 'message view starting -- connecting Gateway' });

  const handler: GatewayEventHandler = {
    onMessage(channelId, message) {
      handleGatewayMessage(channelId, message).catch((err) => {
        log({ source: SOURCE, level: 'error', summary: 'gateway message handler error', data: err });
      });
    },
    onReactionAdd(channelId, messageId, userId, emoji) {
      handleGatewayReaction(channelId, messageId, userId, emoji);
    },
    onReady() {
      log({ source: SOURCE, level: 'info', summary: 'Gateway ready -- discovering forum channel' });
      initForumChannel().catch((err) => {
        log({ source: SOURCE, level: 'error', summary: 'forum channel setup failed', data: err });
      });
    },
  };

  connectGateway(handler).catch((err) => {
    log({ source: SOURCE, level: 'error', summary: 'Gateway connection failed', data: err });
  });

  // Auto-watch new sessions
  if (config.sessions === 'all') {
    const sessionListSub: SessionListSubscriber = {
      id: 'message-view-session-list',
      send(event: SessionListEvent) {
        if (event.type !== 'session_list_upsert') return;
        const session = event.session;
        if (commandSessionIds.has(session.sessionId)) return;
        if (watchedSessions.has(session.sessionId)) return;
        if (session.isSidechain) return;
        if (Date.now() - session.modifiedAt.getTime() > 10 * 60 * 1000) return;
        if (session.projectPath && session.projectPath !== process.cwd()) return;
        void watchSession(session.sessionId, { auto: true }).catch(err => {
          log({ source: SOURCE, level: 'error', summary: `auto-watch failed for ${session.sessionId.slice(0, 8)}`, data: err });
        });
      },
    };
    subscribeSessionList(sessionListSub);
    unsubSessionList = () => unsubscribeSessionList(sessionListSub);
    log({ source: SOURCE, level: 'info', summary: 'auto-watch enabled' });
  }

  heartbeatTimer = setInterval(() => {
    for (const state of watchedSessions.values()) {
      if (!state.dirty || state.syncing) continue;
      void syncSession(state).catch((err) => {
        log({ source: SOURCE, level: 'error', summary: `sync error for ${state.sessionId.slice(0, 8)}`, data: err });
      });
    }
  }, 3000);
}

function tearDown(): void {
  if (unsubSessionList) {
    unsubSessionList();
    unsubSessionList = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  for (const [sessionId, state] of watchedSessions) {
    if (state.channel) {
      try { unsubscribe(state.channel, state.subscriber); } catch { /* best-effort */ }
    }
    archiveThread(state.discordChannelId).catch(() => {});
    channelToSession.delete(state.discordChannelId);
    watchedSessions.delete(sessionId);
  }

  commandSessionIds.clear();
  disconnectGateway();
  activeConfig = null;
  forumChannelId = null;
  ownerUserId = null;
  promptsInFlight = 0;
  shutdownTransport();
}

// ---------------------------------------------------------------------------
// Forum Channel Management
// ---------------------------------------------------------------------------

async function initForumChannel(): Promise<void> {
  if (!activeConfig) return;
  const botId = getBotUserId();
  if (!botId) {
    log({ source: SOURCE, level: 'error', summary: 'bot user ID not available after Gateway ready' });
    return;
  }

  try {
    const app = await discordFetch('GET', '/oauth2/applications/@me') as { owner?: { id: string } };
    ownerUserId = app.owner?.id ?? null;
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: 'failed to discover application owner', data: err });
  }

  forumChannelId = await ensureForumChannel(activeConfig.guildId, botId, ownerUserId);
  log({ source: SOURCE, level: 'info', summary: `forum channel ready: ${forumChannelId}` });
  await rejoinForumThreads(activeConfig.guildId, forumChannelId);
}

async function rejoinForumThreads(guildId: string, forumId: string): Promise<void> {
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

const FORUM_ALLOW_BITS = '76864'; // VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY + MANAGE_MESSAGES + ADD_REACTIONS
const GUILD_FORUM = 15; // Discord channel type for forum channels

async function ensureForumChannel(guildId: string, botId: string, ownerId: string | null): Promise<string> {
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

// ---------------------------------------------------------------------------
// Gateway Event Routing
// ---------------------------------------------------------------------------

async function handleGatewayMessage(
  channelId: string,
  message: {
    id: string;
    content: string;
    author: { id: string; bot?: boolean };
    guild_id?: string;
    mentions?: Array<{ id: string }>;
  },
): Promise<void> {
  const botId = getBotUserId();
  if (!botId || message.author.id === botId) return;

  // Route 1: message in a session post -> follow-up turn
  if (channelToSession.has(channelId)) {
    await handlePostMessage(channelId, message);
    return;
  }

  // Route 2: DM or @mention -> ! commands
  let text: string | null = null;
  if (!message.guild_id) {
    text = message.content.trim();
  } else if (message.mentions?.some(m => m.id === botId)) {
    text = message.content.replace(/<@!?\d+>\s*/g, '').trim();
  }

  if (text) {
    triggerTyping(channelId).catch(() => {});
    await handleCommand(channelId, text, buildCommandContext());
  }
}

function buildCommandContext(): CommandContext {
  return {
    guildId: activeConfig?.guildId ?? null,
    forumReady: !!(activeConfig && forumChannelId),
    uptimeMs: () => Date.now() - startTime,
    watchedCount: () => watchedSessions.size,
    isWatching: (id) => watchedSessions.has(id),
    getWatchDiscordChannelId: (id) => watchedSessions.get(id)?.discordChannelId,
    acquirePromptSlot: () => {
      if (promptsInFlight >= MAX_CONCURRENT_PROMPTS) return false;
      promptsInFlight++;
      return true;
    },
    releasePromptSlot: () => { promptsInFlight--; },
    createSession: createWatchedSession,
    openSession: (id) => watchSession(id, { auto: false }),
  };
}

function handleGatewayReaction(
  channelId: string,
  messageId: string,
  userId: string,
  emoji: string,
): void {
  const botId = getBotUserId();
  if (!botId || userId === botId) return;

  // ❌ on any message in the forum → archive the thread (owner only)
  if (emoji === '\u{274C}' && (!ownerUserId || userId === ownerUserId)) {
    // Check if this is a watched session post
    const sessionId = channelToSession.get(channelId);
    if (sessionId) {
      const state = watchedSessions.get(sessionId);
      if (state) {
        if (state.channel) {
          try { unsubscribe(state.channel, state.subscriber); } catch { /* best-effort */ }
        }
        channelToSession.delete(channelId);
        watchedSessions.delete(sessionId);
      }
    }
    archiveThread(channelId).catch((err) => {
      log({ source: SOURCE, level: 'debug', summary: `archive on \u{274C} failed for ${channelId}`, data: err });
    });
    log({ source: SOURCE, level: 'info', summary: `\u{274C} reaction — archived thread ${channelId}` });
    return;
  }

  // Approval resolution: match pending interactions by message ID + emoji
  const sessionId = channelToSession.get(channelId);
  if (!sessionId) return;
  const state = watchedSessions.get(sessionId);
  if (!state) return;

  for (const [toolUseId, interaction] of state.pendingInteractions) {
    if (interaction.discordMessageId !== messageId) continue;
    const optionId = interaction.emojiToOptionId.get(emoji);
    if (!optionId) continue;

    if (!state.channel) return;
    resolveApproval(state.channel, toolUseId, optionId);
    state.pendingInteractions.delete(toolUseId);

    const opt = interaction.options.find(o => o.id === optionId);
    editMessage(
      state.discordChannelId,
      interaction.discordMessageId,
      `${emoji} **${interaction.toolName}** \u{2014} ${opt?.label ?? optionId}`,
    ).catch(() => {});

    log({ source: SOURCE, level: 'info', summary: `approval resolved: ${interaction.toolName} \u{2192} ${optionId}` });
    return;
  }
}

// ---------------------------------------------------------------------------
// Watch State Management
// ---------------------------------------------------------------------------

async function createWatchedSession(
  vendor: Vendor,
  promptText: string,
): Promise<{ sessionId: string; discordChannelId: string }> {
  if (!activeConfig || !forumChannelId) throw new Error('Forum channel not ready');

  const displayName = promptText.slice(0, 100).replace(/\n/g, ' ').trim() || 'new session';
  const post = await createForumPost(forumChannelId, displayName, '\u{23F3} Starting session\u{2026}', {
    autoArchiveDuration: 1440,
  });

  const discordChannelId = post.id;
  const intent: TurnIntent = {
    target: { kind: 'new', vendor, cwd: process.cwd() },
    content: [{ type: 'text', text: promptText }],
    clientMessageId: crypto.randomUUID(),
    settings: {},
  };

  const tempSessionId = `prompt-${Date.now()}`;
  // Block auto-watch before sendTurn fires session list notifications
  commandSessionIds.add(tempSessionId);
  const subscriber = buildWatchSubscriber(tempSessionId);

  const result = await sendTurn(intent, subscriber);
  commandSessionIds.add(result.sessionId);
  const realId = result.rekeyPromise ? await result.rekeyPromise : result.sessionId;
  commandSessionIds.add(realId);

  // Rename post to canonical session-{prefix} format
  const canonicalName = `session-${realId.slice(0, 8)}`;
  discordFetch('PATCH', `/channels/${discordChannelId}`, { name: canonicalName }).catch((err) => {
    log({ source: SOURCE, level: 'warn', summary: `failed to rename post to ${canonicalName}`, data: err });
  });

  const state = registerWatchState(realId, discordChannelId, subscriber);
  state.channel = await subscribeSession(realId, subscriber);

  log({ source: SOURCE, level: 'info', summary: `created session ${realId.slice(0, 12)}` });
  return { sessionId: realId, discordChannelId };
}

async function watchSession(sessionId: string, opts: { auto: boolean }): Promise<void> {
  if (!activeConfig || !forumChannelId) return;
  if (watchedSessions.has(sessionId)) return;

  const postName = `session-${sessionId.slice(0, 8)}`;
  const anchorText = opts.auto
    ? `\u{1F4E1} Auto-watching session \`${sessionId.slice(0, 8)}\``
    : `\u{1F4E1} Watching session \`${sessionId.slice(0, 8)}\``;
  const post = await createForumPost(forumChannelId, postName, anchorText, {
    autoArchiveDuration: 1440,
  });
  const discordChannelId = post.id;

  const subscriber = buildWatchSubscriber(sessionId);
  const state = registerWatchState(sessionId, discordChannelId, subscriber);

  try {
    state.channel = await subscribeSession(sessionId, subscriber);
  } catch (err) {
    watchedSessions.delete(sessionId);
    channelToSession.delete(discordChannelId);
    archiveThread(discordChannelId).catch(() => {});
    throw err;
  }

  log({ source: SOURCE, level: 'info', summary: `${opts.auto ? 'auto-' : ''}watching session ${sessionId.slice(0, 12)}\u{2026}` });
}

function registerWatchState(
  sessionId: string,
  discordChannelId: string,
  subscriber: Subscriber,
): WatchState {
  const state: WatchState = {
    sessionId,
    discordChannelId,
    subscriber,
    channel: null,
    entries: [],
    toolResults: new Map(),
    messageIds: [],
    currentChunks: [],
    dirty: false,
    pendingInteractions: new Map(),
    syncing: false,
    status: 'connecting',
  };
  watchedSessions.set(sessionId, state);
  channelToSession.set(discordChannelId, sessionId);
  return state;
}

// ---------------------------------------------------------------------------
// Follow-up Turns (user message in forum post)
// ---------------------------------------------------------------------------

async function handlePostMessage(
  postId: string,
  message: { id: string; content: string; author: { id: string } },
): Promise<void> {
  const sessionId = channelToSession.get(postId);
  if (!sessionId) return;
  const state = watchedSessions.get(sessionId);
  if (!state) return;

  const text = message.content.trim();
  if (text.length < MIN_PROMPT_LENGTH || !/[a-zA-Z0-9]/.test(text)) return;

  triggerTyping(postId).catch(() => {});

  const intent: TurnIntent = {
    target: { kind: 'existing', sessionId },
    content: [{ type: 'text', text }],
    clientMessageId: crypto.randomUUID(),
    settings: {},
  };

  try {
    await sendTurn(intent, state.subscriber);
  } catch (err) {
    log({ source: SOURCE, level: 'error', summary: `follow-up turn failed for ${sessionId.slice(0, 8)}`, data: err });
    await sendMessage(postId, `\u{274C} Failed to send turn: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Session Event Subscriber
// ---------------------------------------------------------------------------

function buildWatchSubscriber(sessionId: string): Subscriber {
  return {
    id: `message-view-watch-${sessionId.slice(0, 12)}`,
    send(event: SubscriberMessage): void {
      try {
        let state = watchedSessions.get(sessionId);
        if (!state) {
          for (const s of watchedSessions.values()) {
            if (s.subscriber === this) { state = s; break; }
          }
        }
        if (state) handleWatchEvent(state, event);
      } catch (err) {
        log({ source: SOURCE, level: 'error', summary: `watch subscriber error for ${sessionId.slice(0, 12)}\u{2026}`, data: err });
      }
    },
  };
}

function handleWatchEvent(state: WatchState, event: SubscriberMessage): void {
  switch (event.type) {
    case 'catchup': {
      for (const entry of event.entries) processEntry(state, entry);
      if (event.state === 'streaming' || event.state === 'active') state.status = 'working';
      else if (event.state === 'idle') state.status = 'idle';
      else if (event.state === 'background') state.status = 'background';
      else if (event.state === 'awaiting_approval') {
        state.status = 'approval';
        for (const a of event.pendingApprovals) {
          if (!state.pendingInteractions.has(a.toolUseId)) {
            void postApprovalInteraction(state, a).catch((err) => {
              log({ source: SOURCE, level: 'error', summary: 'failed to post catchup approval', data: err });
            });
          }
        }
      }
      state.dirty = true;
      void syncSession(state).catch((err) => {
        log({ source: SOURCE, level: 'error', summary: 'catchup flush failed', data: err });
      });
      break;
    }

    case 'entry':
      processEntry(state, event.entry);
      state.dirty = true;
      break;

    case 'event': {
      const evt = event.event;
      if (evt.type !== 'status') break;
      state.dirty = true;
      switch (evt.status) {
        case 'active': state.status = 'working'; break;
        case 'idle': state.status = 'idle'; break;
        case 'background': state.status = 'background'; break;
        case 'awaiting_approval':
          state.status = 'approval';
          void postApprovalInteraction(state, {
            toolUseId: evt.toolUseId,
            toolName: evt.toolName,
            input: evt.input,
            reason: evt.reason,
            options: evt.options,
          }).catch((err) => {
            log({ source: SOURCE, level: 'error', summary: 'failed to post approval', data: err });
          });
          break;
      }
      break;
    }
  }
}

function processEntry(state: WatchState, entry: TranscriptEntry): void {
  state.entries.push(entry);
  extractToolResults(state, entry);
}

/** Extract tool_result blocks from user and result entries to populate the toolResults map. */
function extractToolResults(state: WatchState, entry: TranscriptEntry): void {
  // Claude: tool_result blocks inside user entries
  // Codex/OpenCode: tool_result blocks inside top-level result entries
  if (entry.type !== 'user' && entry.type !== 'result') return;

  const content = entry.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_result' && 'tool_use_id' in block) {
      const tr = block as { tool_use_id: string; is_error?: boolean };
      state.toolResults.set(tr.tool_use_id, !!tr.is_error);
    }
  }
}

// ---------------------------------------------------------------------------
// Render -> Diff -> Sync
// ---------------------------------------------------------------------------

async function syncSession(state: WatchState): Promise<void> {
  if (state.syncing) return;
  state.syncing = true;
  state.dirty = false;

  try {
  const chunks = renderSession(state.entries, state.toolResults, getStatusLine(state.status));
  log({ source: SOURCE, level: 'info', summary: `sync ${state.sessionId.slice(0, 8)}: ${chunks.length} chunks from ${state.entries.length} entries (msgs=${state.messageIds.length}, status=${state.status})` });

  const maxLen = Math.max(chunks.length, state.currentChunks.length);
  for (let i = 0; i < maxLen; i++) {
    const chunk = chunks[i];
    const prev = state.currentChunks[i];
    if (chunk === prev) continue;

    if (chunk && state.messageIds[i]) {
      try {
        await editMessage(state.discordChannelId, state.messageIds[i], chunk);
        state.currentChunks[i] = chunk;
      } catch (err) {
        log({ source: SOURCE, level: 'error', summary: `edit failed for chunk ${i}`, data: err });
        state.dirty = true;
        return;
      }
    } else if (chunk && !state.messageIds[i]) {
      try {
        const msg = await sendMessage(state.discordChannelId, chunk);
        state.messageIds[i] = msg.id;
        state.currentChunks[i] = chunk;
      } catch (err) {
        log({ source: SOURCE, level: 'error', summary: `send failed for chunk ${i}`, data: err });
        state.dirty = true;
        return;
      }
    } else if (!chunk && state.messageIds[i]) {
      await editMessage(state.discordChannelId, state.messageIds[i], '\u{200B}').catch(() => {});
      state.currentChunks[i] = '';
    }
  }

  state.currentChunks = chunks;
  log({ source: SOURCE, level: 'info', summary: `sync ${state.sessionId.slice(0, 8)}: complete (${chunks.length} chunks, dirty=${state.dirty})` });
  } finally {
    state.syncing = false;
  }
}

// ---------------------------------------------------------------------------
// Approval Interactions
// ---------------------------------------------------------------------------

const NUMBERED_EMOJI = ['1\u{FE0F}\u{20E3}', '2\u{FE0F}\u{20E3}', '3\u{FE0F}\u{20E3}', '4\u{FE0F}\u{20E3}', '5\u{FE0F}\u{20E3}'];

function buildEmojiMap(options: ApprovalOption[]): Map<string, string> {
  const map = new Map<string, string>();
  let numberedIdx = 0;

  for (const opt of options) {
    const id = opt.id.toLowerCase();
    if (id.includes('deny')) map.set('\u{274C}', opt.id);
    else if (id.includes('allow') && id.includes('session')) map.set('\u{1F501}', opt.id);
    else if (id.includes('allow')) map.set('\u{2705}', opt.id);
    else {
      map.set(NUMBERED_EMOJI[numberedIdx] ?? `${numberedIdx + 1}\u{FE0F}\u{20E3}`, opt.id);
      numberedIdx++;
    }
  }
  return map;
}

function buildApprovalMessage(
  approval: PendingApprovalInfo,
  emojiToOptionId: Map<string, string>,
): string {
  const inputStr = typeof approval.input === 'string'
    ? approval.input.slice(0, 300)
    : JSON.stringify(approval.input).slice(0, 300);
  const reason = approval.reason ? `> ${approval.reason}\n\n` : '';

  const optionLabels: string[] = [];
  for (const [emoji, optionId] of emojiToOptionId) {
    const opt = approval.options.find(o => o.id === optionId);
    optionLabels.push(`${emoji} ${opt?.label ?? optionId}`);
  }

  return truncate(
    `\u{26A0}\u{FE0F} **Approval Required: ${approval.toolName}**\n\`${inputStr}\`\n${reason}${optionLabels.join('  |  ')}`,
    DISCORD_MAX_LENGTH,
  );
}

async function postApprovalInteraction(state: WatchState, approval: PendingApprovalInfo): Promise<void> {
  if (state.pendingInteractions.has(approval.toolUseId)) return;

  const emojiToOptionId = buildEmojiMap(approval.options);
  const text = buildApprovalMessage(approval, emojiToOptionId);
  const msg = await sendMessage(state.discordChannelId, text);

  for (const emoji of emojiToOptionId.keys()) {
    await addReaction(state.discordChannelId, msg.id, emoji).catch((err) => {
      log({ source: SOURCE, level: 'warn', summary: `failed to add reaction ${emoji}`, data: err });
    });
  }

  state.pendingInteractions.set(approval.toolUseId, {
    discordMessageId: msg.id,
    toolUseId: approval.toolUseId,
    toolName: approval.toolName,
    options: approval.options,
    emojiToOptionId,
  });

  log({ source: SOURCE, level: 'info', summary: `posted approval for ${approval.toolName} (${approval.toolUseId.slice(0, 8)})` });
}
