/**
 * Message View — Forum-post-based Discord bot with concierge session
 *
 * Primary flow: user DMs the bot or @mentions it → concierge Claude session
 * interprets the request → creates/loads/lists sessions via text commands →
 * forum posts in #crispy-sessions host sessions. User messages in posts
 * become follow-up turns.
 *
 * Session events render into a MessageBuffer (instant, no API calls).
 * A heartbeat syncs dirty sections to Discord via the projection layer
 * (at most 1 section per session per tick).
 *
 * @module message-view/index
 */

import { readFileSync } from 'node:fs';
import { log } from '../log.js';
import { onSettingsChanged } from '../settings/index.js';
import { settingsPath } from '../paths.js';
import { resolveSessionPrefix, subscribeSession, sendTurn, listAllSessions } from '../session-manager.js';
import { subscribeSessionList, unsubscribeSessionList } from '../session-list-manager.js';
import type { SessionListSubscriber } from '../session-list-manager.js';
import type { SessionListEvent } from '../session-list-events.js';
import { unsubscribe, resolveApproval } from '../session-channel.js';
import type { Subscriber, SubscriberMessage, SessionChannel } from '../session-channel.js';
import type { TranscriptEntry, ContentBlock, ToolResult, Vendor } from '../transcript.js';
import { isTaskResult } from '../transcript.js';
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
  getActiveThreads,
  discordFetch,
  triggerTyping,
} from './discord-transport.js';
import type { GatewayEventHandler } from './discord-transport.js';
import type { DiscordProviderConfig, MessageProviderConfig } from './config.js';
import { initConcierge, shutdownConcierge, routeToConcierge, checkConciergeTimeout, isConciergeSession } from './concierge.js';
import { createBuffer, getOrCreateSection, getLastSection, appendSection, updateSection, clearBuffer } from './buffer.js';
import type { MessageBuffer } from './buffer.js';
import { createProjection, syncOneDirtySection, clearProjection } from './projection.js';
import type { ProjectionState } from './projection.js';

const SOURCE = 'message-view';
const SECTION_SOFT_LIMIT = 3800;
const DISCORD_MAX_LENGTH = 4000;
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
// Watch state — session projection
// ---------------------------------------------------------------------------

interface PendingInteraction {
  discordMessageId: string;
  toolUseId: string;
  toolName: string;
  options: ApprovalOption[];
  emojiToOptionId: Map<string, string>;
}

/** A fragment within a content section — either prose or a tool line. */
interface ContentFragment {
  kind: 'text' | 'tool';
  /** For tool fragments: the tool_use_id (for pairing on result). */
  toolId?: string;
  /** The rendered text of this fragment. */
  text: string;
}

/** A running content section — rendered by joining fragments. */
interface ContentSectionState {
  sectionId: string;
  fragments: ContentFragment[];
  /** True when fragments changed since last render to buffer. */
  needsRender: boolean;
}

interface WatchState {
  sessionId: string;
  discordChannelId: string;
  subscriber: Subscriber;
  channel: SessionChannel;
  buffer: MessageBuffer;
  projection: ProjectionState;
  pendingInteractions: Map<string, PendingInteraction>;
  /** Ordered list of running content sections. */
  contentSections: ContentSectionState[];
  /** Reverse index: toolId → sectionId (for fast tool pairing). */
  toolIndex: Map<string, string>;
  /** Monotonic counter for content section IDs. */
  sectionCounter: number;
  /** Force next content into a new section (set on user turn boundary). */
  newTurn: boolean;
  /** When true, catchup builds state but skips Discord flush (old messages already exist). */
  reconnecting: boolean;
  /** Set on sub-agent posts — the parent session ID that spawned this. */
  parentSessionId?: string;
}

/** Maps sessionId → watch state for active projections. */
const watchedSessions = new Map<string, WatchState>();

/** Reverse map: discordChannelId → sessionId (for routing post messages). */
const channelToSession = new Map<string, string>();

// knownSubagentSessions removed — using session.isSidechain from SessionInfo instead

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initMessageView(): void {
  const config = findEnabledDiscordProvider();
  if (!config) {
    log({ source: SOURCE, level: 'info', summary: 'no enabled discord provider found — skipping init' });
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
// Internals
// ---------------------------------------------------------------------------

function findEnabledDiscordProvider(): DiscordProviderConfig | null {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    const providers = raw.messageProviders as MessageProviderConfig[] | undefined;
    if (!providers) return null;
    const discord = providers.find((p: MessageProviderConfig) => p.type === 'discord' && p.enabled);
    return discord ?? null;
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

  log({ source: SOURCE, level: 'info', summary: 'message view starting — connecting Gateway' });

  // Wire up Gateway event handlers
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
      log({ source: SOURCE, level: 'info', summary: 'Gateway ready — discovering forum channel' });
      // Forum channel setup after Gateway is ready (bot ID is now available)
      initForumChannel().catch((err) => {
        log({ source: SOURCE, level: 'error', summary: 'forum channel setup failed', data: err });
      });
    },
  };

  connectGateway(handler).catch((err) => {
    log({ source: SOURCE, level: 'error', summary: 'Gateway connection failed', data: err });
  });

  // Auto-watch: subscribe to session list events so new sessions are watched automatically
  if (config.sessions === 'all') {
    const sessionListSub: SessionListSubscriber = {
      id: 'message-view-session-list',
      send(event: SessionListEvent) {
        if (event.type === 'session_list_upsert') {
          const session = event.session;
          // Filter: concierge sessions (checked by ID set in concierge module)
          if (isConciergeSession(session.sessionId)) return;
          // Filter: already watched
          if (watchedSessions.has(session.sessionId)) return;
          // Filter: sidechain/sub-agent sessions
          if (session.isSidechain) return;
          // Filter: stale sessions (older than 10 min)
          const ageMs = Date.now() - session.modifiedAt.getTime();
          if (ageMs > 10 * 60 * 1000) return;
          // Filter: sessions not in the current project directory
          const cwd = process.cwd();
          if (session.projectPath && session.projectPath !== cwd) return;
          void watchSession(session.sessionId, { auto: true }).catch(err => {
            log({ source: SOURCE, level: 'error', summary: `auto-watch failed for ${session.sessionId.slice(0, 8)}`, data: err });
          });
        }
      },
    };
    subscribeSessionList(sessionListSub);
    unsubSessionList = () => unsubscribeSessionList(sessionListSub);
    log({ source: SOURCE, level: 'info', summary: 'auto-watch enabled — subscribing to session list' });
  }

  // Projection heartbeat — render pending fragments, then sync dirty sections
  heartbeatTimer = setInterval(() => {
    checkConciergeTimeout();
    for (const state of watchedSessions.values()) {
      // Stage 1: render any content sections with new fragments into the buffer
      renderPendingContentSections(state);
      // Stage 2: sync one dirty buffer section to Discord
      syncOneDirtySection(state.projection, state.buffer).catch((err) => {
        log({ source: SOURCE, level: 'error', summary: `projection sync error for ${state.sessionId.slice(0, 8)}`, data: err });
      });
    }
  }, 3000);
}

/** Discover or create the forum channel + resolve the application owner. */
async function initForumChannel(): Promise<void> {
  if (!activeConfig) return;
  const botId = getBotUserId();
  if (!botId) {
    log({ source: SOURCE, level: 'error', summary: 'bot user ID not available after Gateway ready' });
    return;
  }

  // Discover the application owner
  try {
    const app = await discordFetch('GET', '/oauth2/applications/@me') as { owner?: { id: string } };
    ownerUserId = app.owner?.id ?? null;
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: 'failed to discover application owner', data: err });
  }

  forumChannelId = await ensureForumChannel(activeConfig.guildId, botId, ownerUserId);
  log({ source: SOURCE, level: 'info', summary: `forum channel ready: ${forumChannelId}` });

  // Reconnect to existing forum posts from previous sessions
  await reconnectExistingPosts(activeConfig.guildId, forumChannelId).catch((err) => {
    log({ source: SOURCE, level: 'warn', summary: 'reconnect to existing posts failed', data: err });
  });

  // Initialize concierge with callbacks that create forum posts
  initConcierge({
    model: activeConfig.conciergeModel ?? 'haiku',
    guildId: activeConfig.guildId,
    startTime,
    createSession: async (vendor, prompt) => {
      if (!forumChannelId) throw new Error('Forum channel not ready');
      return await conciergeCreateSession(vendor, prompt);
    },
    openSession: async (prefix) => {
      return await conciergeOpenSession(prefix);
    },
  });
}

// VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY + MANAGE_MESSAGES + ADD_REACTIONS
const FORUM_ALLOW_BITS = '76864';

/** Find or create the #crispy-sessions forum channel, repairing permissions on every startup. */
async function ensureForumChannel(guildId: string, botId: string, ownerId: string | null): Promise<string> {
  const channels = await getGuildChannels(guildId);
  const existing = channels.find(c => c.name === 'crispy-sessions' && c.type === 15);

  if (existing) {
    // Repair permissions on every startup — ensures new permission bits are applied
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
    type: 15,
    permissionOverwrites,
  });
  log({ source: SOURCE, level: 'info', summary: `created forum channel: ${forum.id}` });
  return forum.id;
}

/** Ensure bot and owner have correct permissions on the forum channel. */
async function repairForumPermissions(channelId: string, guildId: string, botId: string, ownerId: string | null): Promise<void> {
  try {
    // @everyone deny VIEW_CHANNEL
    await discordFetch('PUT', `/channels/${channelId}/permissions/${guildId}`, { type: 0, deny: '1024' });
    // Bot allow
    await discordFetch('PUT', `/channels/${channelId}/permissions/${botId}`, { type: 1, allow: FORUM_ALLOW_BITS });
    // Owner allow
    if (ownerId) {
      await discordFetch('PUT', `/channels/${channelId}/permissions/${ownerId}`, { type: 1, allow: FORUM_ALLOW_BITS });
    }
    log({ source: SOURCE, level: 'debug', summary: 'forum permissions verified' });
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: 'failed to repair forum permissions', data: err });
  }
}

/**
 * Reconnect to existing forum posts from a previous bot lifetime.
 * Scans active threads in the forum, matches session IDs from post names,
 * and re-subscribes in parallel via watchSession.
 */
async function reconnectExistingPosts(guildId: string, forumId: string): Promise<void> {
  const threads = await getActiveThreads(guildId);
  const forumThreads = threads.filter(t => t.parent_id === forumId);
  if (forumThreads.length === 0) return;

  const allSessions = listAllSessions();
  const sessionsByPrefix = new Map<string, string>();
  for (const s of allSessions) {
    sessionsByPrefix.set(s.sessionId.slice(0, 8), s.sessionId);
  }

  // Match forum posts to sessions and reconnect in parallel
  const reconnectTasks: Promise<void>[] = [];
  for (const thread of forumThreads) {
    const match = thread.name.match(/^session-([a-f0-9]{8})/);
    if (!match) {
      log({ source: SOURCE, level: 'debug', summary: `skipping unmatched post: ${thread.name}` });
      continue;
    }

    const fullId = sessionsByPrefix.get(match[1]);
    if (!fullId || watchedSessions.has(fullId)) continue;

    reconnectTasks.push(
      watchSession(fullId, { auto: true, existingPostId: thread.id }).catch(err => {
        log({ source: SOURCE, level: 'warn', summary: `reconnect failed for ${match[1]}`, data: err });
      }),
    );
  }

  await Promise.all(reconnectTasks);
  if (reconnectTasks.length > 0) {
    log({ source: SOURCE, level: 'info', summary: `reconnected to ${reconnectTasks.length} existing forum post${reconnectTasks.length > 1 ? 's' : ''}` });
  }
}

function tearDown(): void {
  shutdownConcierge();

  if (unsubSessionList) {
    unsubSessionList();
    unsubSessionList = null;
  }

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  for (const [sessionId, state] of watchedSessions) {
    try {
      unsubscribe(state.channel, state.subscriber);
    } catch { /* best-effort */ }
    clearBuffer(state.buffer);
    clearProjection(state.projection);
    archiveThread(state.discordChannelId).catch(() => {});
    channelToSession.delete(state.discordChannelId);
    watchedSessions.delete(sessionId);
  }

  disconnectGateway();
  activeConfig = null;
  forumChannelId = null;
  ownerUserId = null;
  promptsInFlight = 0;
  shutdownTransport();
}

// ---------------------------------------------------------------------------
// Gateway Event Handlers
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
  if (!botId) return;

  // Ignore our own messages
  if (message.author.id === botId) return;

  // Route 1: message in a session post → follow-up turn
  if (channelToSession.has(channelId)) {
    await handlePostMessage(channelId, message);
    return;
  }

  // Route 2: DM (no guild_id) → route to concierge
  if (!message.guild_id) {
    const text = message.content.trim();
    if (text) {
      triggerTyping(channelId).catch(() => {});
      await routeToConcierge(channelId, text);
    }
    return;
  }

  // Route 3: @mention in a guild channel → route to concierge
  if (message.mentions?.some(m => m.id === botId)) {
    const content = message.content.replace(/<@!?\d+>\s*/g, '').trim();
    if (content) {
      triggerTyping(channelId).catch(() => {});
      await routeToConcierge(channelId, content);
    }
    return;
  }
}

function handleGatewayReaction(
  channelId: string,
  messageId: string,
  userId: string,
  emoji: string,
): void {
  const botId = getBotUserId();
  if (!botId || userId === botId) return;

  // Find the session that owns this channel
  const sessionId = channelToSession.get(channelId);
  if (!sessionId) return;
  const state = watchedSessions.get(sessionId);
  if (!state) return;

  // Check all pending interactions for a match on messageId + emoji
  for (const [toolUseId, interaction] of state.pendingInteractions) {
    if (interaction.discordMessageId !== messageId) continue;

    const optionId = interaction.emojiToOptionId.get(emoji);
    if (!optionId) continue;

    // Resolve the approval
    resolveApproval(state.channel, toolUseId, optionId);
    state.pendingInteractions.delete(toolUseId);

    const opt = interaction.options.find(o => o.id === optionId);
    editMessage(
      state.discordChannelId,
      interaction.discordMessageId,
      `${emoji} **${interaction.toolName}** — ${opt?.label ?? optionId}`,
    ).catch(() => { /* best-effort */ });

    log({
      source: SOURCE,
      level: 'info',
      summary: `approval resolved: ${interaction.toolName} → ${optionId}`,
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// Concierge Callbacks — create/open sessions with forum posts
// ---------------------------------------------------------------------------

async function conciergeCreateSession(vendor: Vendor, promptText: string): Promise<{ sessionId: string; link: string }> {
  if (!activeConfig || !forumChannelId) throw new Error('Forum channel not ready');

  if (promptsInFlight >= MAX_CONCURRENT_PROMPTS) {
    throw new Error('Too many sessions starting concurrently — try again in a moment.');
  }

  promptsInFlight++;
  try {
    const postName = promptText.slice(0, 100).replace(/\n/g, ' ').trim() || `session-${Date.now()}`;
    const post = await createForumPost(forumChannelId, postName, '\u{23F3} Starting session\u{2026}', {
      autoArchiveDuration: 1440,
    });

    const discordChannelId = post.id;
    const buffer = createBuffer();
    const projection = createProjection(discordChannelId);
    appendSection(buffer, 'status', '\u{23F3} Working\u{2026}');

    const cwd = process.cwd();
    const intent: TurnIntent = {
      target: { kind: 'new', vendor, cwd },
      content: [{ type: 'text', text: promptText }],
      clientMessageId: crypto.randomUUID(),
      settings: {},
    };

    const tempSessionId = `prompt-${Date.now()}`;
    const subscriber = buildWatchSubscriber(tempSessionId, buffer);

    const result = await sendTurn(intent, subscriber);
    const realId = result.rekeyPromise ? await result.rekeyPromise : result.sessionId;

    const state = registerWatchState(realId, discordChannelId, subscriber, null, buffer, projection);
    state.channel = await subscribeSession(realId, subscriber);

    const link = `https://discord.com/channels/${activeConfig.guildId}/${discordChannelId}`;
    log({ source: SOURCE, level: 'info', summary: `concierge created session ${realId.slice(0, 12)} in "${postName}"` });
    return { sessionId: realId, link };
  } finally {
    promptsInFlight--;
  }
}

async function conciergeOpenSession(prefix: string): Promise<string> {
  if (!activeConfig || !forumChannelId) throw new Error('Forum channel not ready');

  const resolvedId = resolveSessionPrefix(prefix);

  if (watchedSessions.has(resolvedId)) {
    const state = watchedSessions.get(resolvedId)!;
    return `https://discord.com/channels/${activeConfig.guildId}/${state.discordChannelId}`;
  }

  await watchSession(resolvedId, { auto: false });
  const state = watchedSessions.get(resolvedId);
  if (!state) throw new Error('Failed to watch session');
  return `https://discord.com/channels/${activeConfig.guildId}/${state.discordChannelId}`;
}

// ---------------------------------------------------------------------------
// Watch Session — create forum post, subscribe, project
// ---------------------------------------------------------------------------

interface WatchSessionOpts {
  auto: boolean;
  /** If set, reuse an existing forum post instead of creating a new one. */
  existingPostId?: string;
}

async function watchSession(sessionId: string, opts: WatchSessionOpts): Promise<void> {
  if (!activeConfig || !forumChannelId) return;

  if (watchedSessions.has(sessionId)) return;

  let discordChannelId: string;
  if (opts.existingPostId) {
    discordChannelId = opts.existingPostId;
  } else {
    const postName = `session-${sessionId.slice(0, 8)}`;
    const anchorText = opts.auto
      ? `\u{1F4E1} Auto-watching session \`${sessionId.slice(0, 8)}\``
      : `\u{1F4E1} Watching session \`${sessionId.slice(0, 8)}\``;
    const post = await createForumPost(forumChannelId, postName, anchorText, {
      autoArchiveDuration: 1440,
    });
    discordChannelId = post.id;
  }

  const statusText = opts.existingPostId ? '\u{1F504} Reconnecting\u{2026}' : '\u{23F3} Connecting\u{2026}';
  const buffer = createBuffer();
  const projection = createProjection(discordChannelId);
  appendSection(buffer, 'status', statusText);

  const subscriber = buildWatchSubscriber(sessionId, buffer);

  // Pre-register so catchup (delivered synchronously by subscribe) can find the state
  const state = registerWatchState(sessionId, discordChannelId, subscriber, null, buffer, projection);
  if (opts.existingPostId) state.reconnecting = true;

  try {
    state.channel = await subscribeSession(sessionId, subscriber);
    // After subscribe completes, clear reconnecting so future events project normally
    state.reconnecting = false;
  } catch (err) {
    // Roll back pre-registration
    watchedSessions.delete(sessionId);
    channelToSession.delete(discordChannelId);
    if (!opts.existingPostId) archiveThread(discordChannelId).catch(() => {});
    throw err;
  }

  log({ source: SOURCE, level: 'info', summary: `${opts.existingPostId ? 're' : opts.auto ? 'auto-' : ''}watching session ${sessionId.slice(0, 12)}\u{2026}` });
}

// ---------------------------------------------------------------------------
// Bidirectional — user message in post → follow-up turn
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
  if (text.length < MIN_PROMPT_LENGTH) return;
  if (!/[a-zA-Z0-9]/.test(text)) return;

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
    try {
      await sendMessage(postId, `\u{274C} Failed to send turn: ${err instanceof Error ? err.message : String(err)}`);
    } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Session Event Subscriber
// ---------------------------------------------------------------------------

function registerWatchState(
  sessionId: string,
  discordChannelId: string,
  subscriber: Subscriber,
  channel: SessionChannel | null,
  buffer: MessageBuffer,
  projection: ProjectionState,
): WatchState {
  const state: WatchState = {
    sessionId,
    discordChannelId,
    subscriber,
    channel: channel!,
    buffer,
    projection,
    pendingInteractions: new Map(),
    contentSections: [],
    toolIndex: new Map(),
    sectionCounter: 0,
    newTurn: false,
    reconnecting: false,
  };
  watchedSessions.set(sessionId, state);
  channelToSession.set(discordChannelId, sessionId);
  return state;
}

function buildWatchSubscriber(sessionId: string, buffer: MessageBuffer): Subscriber {
  return {
    id: `message-view-watch-${sessionId.slice(0, 12)}`,
    send(event: SubscriberMessage): void {
      try {
        const state = watchedSessions.get(sessionId) ?? findWatchStateBySubscriber(this as Subscriber);
        handleWatchEvent(buffer, event, state);
      } catch (err) {
        log({ source: SOURCE, level: 'error', summary: `watch subscriber error for ${sessionId.slice(0, 12)}\u{2026}`, data: err });
      }
    },
  };
}

function findWatchStateBySubscriber(sub: Subscriber): WatchState | undefined {
  for (const state of watchedSessions.values()) {
    if (state.subscriber === sub) return state;
  }
  return undefined;
}

/**
 * Flush ALL dirty sections to Discord immediately (used after catchup).
 * Sections sync sequentially to preserve message ordering in the post.
 */
async function flushAllDirtySections(state: WatchState): Promise<void> {
  let synced = 0;
  // Cap iterations to prevent infinite loops on persistent API failures
  // (syncOneDirtySection returns true but leaves section dirty on error)
  const maxIterations = state.buffer.sections.length + 5;
  let iterations = 0;
  while (await syncOneDirtySection(state.projection, state.buffer)) {
    synced++;
    if (++iterations >= maxIterations) {
      log({ source: SOURCE, level: 'warn', summary: `flush capped at ${iterations} iterations for ${state.sessionId.slice(0, 8)} — remaining sections will sync via heartbeat` });
      break;
    }
  }
  if (synced > 0) {
    log({ source: SOURCE, level: 'info', summary: `flushed ${synced} sections for ${state.sessionId.slice(0, 8)}` });
  }
}

function handleWatchEvent(buffer: MessageBuffer, event: SubscriberMessage, state: WatchState | undefined): void {
  switch (event.type) {
    case 'catchup': {
      // Render ALL entries into the buffer first (synchronous, no API calls)
      for (const entry of event.entries) {
        renderEntryToBuffer(buffer, entry, state);
      }
      const statusSection = getOrCreateSection(buffer, 'status', '');
      if (event.state === 'streaming' || event.state === 'active') {
        updateSection(statusSection, '\u{23F3} Working\u{2026}');
      } else if (event.state === 'idle') {
        updateSection(statusSection, '\u{2705} Done');
        if (state && isSubagentPost(state)) {
          void addCleanupReaction(state).catch(() => {});
        }
      } else if (event.state === 'awaiting_approval' && event.pendingApprovals.length > 0) {
        const tools = event.pendingApprovals.map(a => a.toolName).join(', ');
        updateSection(statusSection, `\u{26A0}\u{FE0F} Awaiting approval: ${tools}`);
        if (state) {
          for (const approval of event.pendingApprovals) {
            if (!state.pendingInteractions.has(approval.toolUseId)) {
              void postApprovalInteraction(state, approval).catch((err) => {
                log({ source: SOURCE, level: 'error', summary: 'failed to post catchup approval', data: err });
              });
            }
          }
        }
      }
      // Render all content sections once (catchup appended fragments without rendering)
      if (state) renderPendingContentSections(state);

      // On reconnect: old messages already exist in Discord — just clear dirty flags
      // and only project the status section. On fresh watch: flush everything.
      if (state?.reconnecting) {
        for (const section of buffer.sections) {
          if (section.id !== 'status') section.dirty = false;
        }
        // Only sync the status section so it shows current state
        void syncOneDirtySection(state.projection, state.buffer).catch(() => {});
        log({ source: SOURCE, level: 'info', summary: `reconnect catchup: built state from ${event.entries.length} entries, skipped flush` });
      } else if (state) {
        void flushAllDirtySections(state).catch((err) => {
          log({ source: SOURCE, level: 'error', summary: 'catchup flush failed', data: err });
        });
      }
      break;
    }

    case 'entry': {
      renderEntryToBuffer(buffer, event.entry, state);
      break;
    }

    case 'event': {
      const evt = event.event;
      if (evt.type === 'status') {
        const statusSection = getOrCreateSection(buffer, 'status', '');
        switch (evt.status) {
          case 'active':
            updateSection(statusSection, '\u{23F3} Working\u{2026}');
            break;
          case 'idle':
            updateSection(statusSection, '\u{2705} Done');
            // Add ✅ reaction on sub-agent completion for manual cleanup
            if (state && isSubagentPost(state)) {
              void addCleanupReaction(state).catch(() => {});
            }
            break;
          case 'awaiting_approval':
            updateSection(statusSection, `\u{26A0}\u{FE0F} Awaiting approval: ${evt.toolName}`);
            if (state) {
              void postApprovalInteraction(state, {
                toolUseId: evt.toolUseId,
                toolName: evt.toolName,
                input: evt.input,
                reason: evt.reason,
                options: evt.options,
              }).catch((err) => {
                log({ source: SOURCE, level: 'error', summary: 'failed to post approval', data: err });
              });
            }
            break;
          case 'background':
            updateSection(statusSection, '\u{1F504} Background');
            break;
        }
      }
      break;
    }
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
    if (id.includes('deny')) {
      map.set('\u{274C}', opt.id);
    } else if (id.includes('allow') && id.includes('session')) {
      map.set('\u{1F501}', opt.id);
    } else if (id.includes('allow')) {
      map.set('\u{2705}', opt.id);
    } else {
      const emoji = NUMBERED_EMOJI[numberedIdx] ?? `${numberedIdx + 1}\u{FE0F}\u{20E3}`;
      map.set(emoji, opt.id);
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

async function postApprovalInteraction(
  state: WatchState,
  approval: PendingApprovalInfo,
): Promise<void> {
  if (state.pendingInteractions.has(approval.toolUseId)) return;

  const emojiToOptionId = buildEmojiMap(approval.options);
  const text = buildApprovalMessage(approval, emojiToOptionId);

  const msg = await sendMessage(state.discordChannelId, text);

  for (const emoji of emojiToOptionId.keys()) {
    try {
      await addReaction(state.discordChannelId, msg.id, emoji);
    } catch (err) {
      log({ source: SOURCE, level: 'warn', summary: `failed to add reaction ${emoji}`, data: err });
    }
  }

  state.pendingInteractions.set(approval.toolUseId, {
    discordMessageId: msg.id,
    toolUseId: approval.toolUseId,
    toolName: approval.toolName,
    options: approval.options,
    emojiToOptionId,
  });

  log({
    source: SOURCE,
    level: 'info',
    summary: `posted approval interaction for ${approval.toolName} (${approval.toolUseId.slice(0, 8)})`,
  });
}

// ---------------------------------------------------------------------------
// Buffer Rendering — running content sections with inline tool pairing
// ---------------------------------------------------------------------------

/** Compute the rendered length of a content section. */
function contentSectionLength(cs: ContentSectionState): number {
  let len = 0;
  for (let i = 0; i < cs.fragments.length; i++) {
    if (i > 0) len += 1; // newline separator
    len += cs.fragments[i].text.length;
  }
  return len;
}

/** Render a content section's fragments to a string. */
function renderContentSection(cs: ContentSectionState): string {
  return cs.fragments.map(f => f.text).join('\n');
}

/** Re-render a content section into the MessageBuffer, marking it dirty. */
function syncContentToBuffer(cs: ContentSectionState, buffer: MessageBuffer): void {
  const section = getOrCreateSection(buffer, cs.sectionId, '');
  updateSection(section, truncateAtNewline(renderContentSection(cs), SECTION_SOFT_LIMIT));
  cs.needsRender = false;
}

/**
 * Render all content sections that have pending fragment changes into the buffer.
 * Called once per heartbeat tick — decouples fragment appends from Discord sync.
 */
function renderPendingContentSections(state: WatchState): void {
  for (const cs of state.contentSections) {
    if (cs.needsRender) {
      syncContentToBuffer(cs, state.buffer);
    }
  }
}

/**
 * Get the tail content section, or create a new one.
 * Forces a new section on user turn boundaries or when approaching the char limit.
 */
function getCurrentContentSection(
  state: WatchState,
  buffer: MessageBuffer,
  incomingLength: number,
): ContentSectionState {
  const forceNew = state.newTurn;
  if (forceNew) state.newTurn = false;

  const tail = state.contentSections[state.contentSections.length - 1];

  if (!forceNew && tail) {
    const projected = contentSectionLength(tail) + 1 + incomingLength;
    if (projected <= SECTION_SOFT_LIMIT) {
      return tail;
    }
  }

  // Create new content section
  state.sectionCounter++;
  const sectionId = `content-${state.sectionCounter}`;
  const cs: ContentSectionState = { sectionId, fragments: [], needsRender: false };
  state.contentSections.push(cs);
  appendSection(buffer, sectionId, '');
  return cs;
}

/** Append a text fragment to the running content (no render — deferred to heartbeat). */
function appendTextFragment(state: WatchState, buffer: MessageBuffer, text: string): void {
  const rendered = text.slice(0, 3000); // truncate huge single blocks
  const cs = getCurrentContentSection(state, buffer, rendered.length);
  cs.fragments.push({ kind: 'text', text: rendered });
  cs.needsRender = true;
}

/** Append a tool_use fragment to the running content (no render — deferred to heartbeat). */
function appendToolFragment(state: WatchState, buffer: MessageBuffer, toolId: string, line: string): void {
  const cs = getCurrentContentSection(state, buffer, line.length);
  cs.fragments.push({ kind: 'tool', toolId, text: line });
  state.toolIndex.set(toolId, cs.sectionId);
  cs.needsRender = true;
}

/**
 * Update a tool line's status emoji when tool_result arrives.
 * Finds the fragment via toolIndex, mutates it, re-renders the section.
 */
function completeToolLine(state: WatchState, buffer: MessageBuffer, toolId: string, isError: boolean): void {
  const sectionId = state.toolIndex.get(toolId);
  if (!sectionId) return;

  const cs = state.contentSections.find(s => s.sectionId === sectionId);
  if (!cs) return;

  const frag = cs.fragments.find(f => f.kind === 'tool' && f.toolId === toolId);
  if (!frag) return;

  const status = isError ? '\u{2717}' : '\u{2713}';
  frag.text = frag.text.replace('\u{23F3}', status);
  cs.needsRender = true;
}

function renderEntryToBuffer(buffer: MessageBuffer, entry: TranscriptEntry, state: WatchState | undefined): void {
  const content = entry.message?.content;
  if (!content) return;

  if (entry.type === 'user') {
    // Process tool_result blocks BEFORE marking turn boundary (they arrive on user entries)
    if (Array.isArray(content) && state) {
      for (const block of content) {
        if (block.type === 'tool_result' && 'tool_use_id' in block) {
          const toolResult = block as { type: 'tool_result'; tool_use_id: string; is_error?: boolean };
          completeToolLine(state, buffer, toolResult.tool_use_id, !!toolResult.is_error);
        }
      }
    }

    // Sub-agent forum posts disabled for now — too noisy
    // if (state && entry.toolUseResult) {
    //   handleSubagentResult(state, entry.toolUseResult, content);
    // }

    // Turn boundary — force new section so next output appears after user's Discord message
    if (state) {
      state.newTurn = true;
    }
    return;
  }

  if (entry.type === 'assistant') {
    renderAssistantToBuffer(buffer, content, state);
    return;
  }

  // result, system, etc. — skip
}

function renderAssistantToBuffer(
  buffer: MessageBuffer,
  content: string | ContentBlock[],
  state: WatchState | undefined,
): void {
  if (!state) {
    // Fallback for stateless catchup — dump into a simple section
    if (typeof content === 'string' && content) {
      appendSection(buffer, `catchup-${Date.now()}`, truncateAtNewline(content, SECTION_SOFT_LIMIT));
    }
    return;
  }

  if (typeof content === 'string') {
    if (content) appendTextFragment(state, buffer, content);
    return;
  }

  for (const block of content) {
    switch (block.type) {
      case 'text': {
        if (block.text) appendTextFragment(state, buffer, block.text);
        break;
      }
      case 'tool_use': {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const line = renderToolUse(block.name, input);
        if (block.id) {
          appendToolFragment(state, buffer, block.id, line);
        } else {
          appendTextFragment(state, buffer, line);
        }
        break;
      }
      // tool_result, thinking, image — skip
    }
  }
}

// ---------------------------------------------------------------------------
// Tool Rendering
// ---------------------------------------------------------------------------

function shortPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : filePath;
}

function extractSubject(input: Record<string, unknown>): string {
  const fields = ['file_path', 'command', 'pattern', 'path', 'description', 'prompt', 'url', 'query', 'skill', 'task_id', 'name'];
  for (const field of fields) {
    const val = input[field];
    if (typeof val === 'string' && val) {
      return val.split('\n')[0].slice(0, 50);
    }
  }
  return '';
}

function renderToolUse(name: string, input: Record<string, unknown>): string {
  switch (name.toLowerCase()) {
    case 'bash': {
      const desc = input.description as string | undefined;
      const cmd = (input.command as string ?? '').split('\n')[0].slice(0, 50);
      const subject = desc ? desc.slice(0, 50) : cmd;
      const badges: string[] = [];
      if (input.run_in_background) badges.push('[background]');
      if (input.timeout) badges.push(`[\u{23F1} ${Math.round((input.timeout as number) / 1000)}s]`);
      const meta = badges.length ? ` ${badges.join(' ')}` : '';
      return `\u{1F4BB} **bash**${meta}  \`${subject}\`  \u{23F3}`;
    }
    case 'read': {
      const path = shortPath(input.file_path as string ?? '');
      const range = input.offset ? `:${input.offset}-${(input.offset as number) + (input.limit as number ?? 100)}` : '';
      return `\u{1F4C4} **read**  \`${path}${range}\`  \u{23F3}`;
    }
    case 'write': {
      const path = shortPath(input.file_path as string ?? '');
      const lines = typeof input.content === 'string' ? input.content.split('\n').length : 0;
      return `\u{270E} **write**  \`${path}\` (${lines} lines)  \u{23F3}`;
    }
    case 'edit': {
      const path = shortPath(input.file_path as string ?? '');
      const addLines = typeof input.new_string === 'string' ? input.new_string.split('\n').length : 0;
      const delLines = typeof input.old_string === 'string' ? input.old_string.split('\n').length : 0;
      return `\u{1F4DD} **edit**  \`${path}\` +${addLines} -${delLines}  \u{23F3}`;
    }
    case 'grep': {
      const pattern = (input.pattern as string ?? '').slice(0, 40);
      const scope = input.path ?? input.glob ?? input.type ?? '';
      const scopeStr = scope ? ` in ${String(scope).slice(0, 30)}` : '';
      return `\u{1F50D} **grep**  \`${pattern}\`${scopeStr}  \u{23F3}`;
    }
    case 'glob': {
      const pattern = (input.pattern as string ?? '').slice(0, 40);
      const scope = input.path ? ` in ${String(input.path).slice(0, 30)}` : '';
      return `\u{1F4C2} **glob**  \`${pattern}\`${scope}  \u{23F3}`;
    }
    case 'agent': {
      const desc = (input.description as string ?? input.prompt as string ?? '').split('\n')[0].slice(0, 50);
      const badge = input.subagent_type ? ` [${input.subagent_type}]` : '';
      return `\u{1F916} **agent**${badge}  ${desc}  \u{23F3}`;
    }
    case 'skill': {
      const skill = input.skill as string ?? '';
      return `\u{2728} **skill**  ${skill}  \u{23F3}`;
    }
    case 'todowrite':
      return `\u{1F4CB} **todos**  updated  \u{23F3}`;
    case 'websearch': {
      const query = (input.query as string ?? '').slice(0, 40);
      return `\u{1F310} **websearch**  \`${query}\`  \u{23F3}`;
    }
    case 'webfetch': {
      const url = (input.url as string ?? '').slice(0, 60);
      return `\u{1F30E} **webfetch**  \`${url}\`  \u{23F3}`;
    }
    default: {
      if (name.startsWith('mcp__')) {
        const shortName = name.replace('mcp__', '').replace(/__/g, '/');
        const subject = extractSubject(input);
        return `\u{1F50C} **${shortName}**  ${subject}  \u{23F3}`;
      }
      const subject = extractSubject(input);
      return `\u{1F527} **${name}**  ${subject}  \u{23F3}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-agent Forum Posts
// ---------------------------------------------------------------------------

/**
 * Handle a tool_result entry that may contain a sub-agent agentId.
 * Creates a linked forum post for the sub-agent and updates the parent tool line.
 */
function handleSubagentResult(
  parentState: WatchState,
  result: ToolResult,
  content: string | ContentBlock[] | undefined,
): void {
  if (!isTaskResult(result)) return;

  const agentId = result.agentId;
  if (!agentId) return;

  // Find the parent tool_use_id from tool_result content blocks
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_result' && 'tool_use_id' in block) {
      const toolUseId = (block as { tool_use_id: string }).tool_use_id;
      void createSubagentPost(parentState, toolUseId, agentId).catch(err => {
        log({ source: SOURCE, level: 'error', summary: 'sub-agent post creation failed', data: err });
      });
      break;
    }
  }
}

/**
 * Create a forum post for a sub-agent session, subscribe to it,
 * and update the parent tool line with a clickable link.
 */
async function createSubagentPost(
  parentState: WatchState,
  parentToolUseId: string,
  agentSessionId: string,
): Promise<void> {
  if (!forumChannelId || !activeConfig) return;

  // Don't create duplicate posts for already-watched sub-agents
  if (watchedSessions.has(agentSessionId)) {
    // Still update the parent tool line with a link to the existing post
    const existingState = watchedSessions.get(agentSessionId)!;
    linkParentToolLine(parentState, parentToolUseId, existingState.discordChannelId);
    return;
  }

  // Derive post name from the parent tool fragment description
  const frag = findToolFragment(parentState, parentToolUseId);
  const rawDesc = frag
    ? frag.text.replace(/[⏳✓✗]/g, '').replace(/\*\*/g, '').trim()
    : 'sub-agent';
  const postName = `\u{2192} ${rawDesc}`.slice(0, 100);

  const post = await createForumPost(forumChannelId, postName, '\u{23F3} Loading sub-agent\u{2026}', {
    autoArchiveDuration: 60,
  });

  const discordChannelId = post.id;
  const buffer = createBuffer();
  const projection = createProjection(discordChannelId);
  appendSection(buffer, 'status', '\u{23F3} Loading\u{2026}');

  const subscriber = buildWatchSubscriber(agentSessionId, buffer);

  // Pre-register so catchup events can find the state
  const subState = registerWatchState(agentSessionId, discordChannelId, subscriber, null, buffer, projection);
  subState.parentSessionId = parentState.sessionId;

  try {
    subState.channel = await subscribeSession(agentSessionId, subscriber);
  } catch (err) {
    // Roll back pre-registration
    watchedSessions.delete(agentSessionId);
    channelToSession.delete(discordChannelId);
    const msg = err instanceof Error ? err.message : String(err);
    log({ source: SOURCE, level: 'error', summary: `sub-agent subscribe failed: ${msg}` });
    await sendMessage(discordChannelId, `\u{274C} Failed to load sub-agent: ${msg}`).catch(() => {});
    return;
  }

  // Update parent tool line with clickable link
  linkParentToolLine(parentState, parentToolUseId, discordChannelId);

  log({ source: SOURCE, level: 'info', summary: `sub-agent post created for ${agentSessionId.slice(0, 8)} in "${postName}"` });
}

/** Find a tool fragment by toolId across all content sections. */
function findToolFragment(state: WatchState, toolId: string): ContentFragment | undefined {
  const sectionId = state.toolIndex.get(toolId);
  if (!sectionId) return undefined;
  const cs = state.contentSections.find(s => s.sectionId === sectionId);
  if (!cs) return undefined;
  return cs.fragments.find(f => f.kind === 'tool' && f.toolId === toolId);
}

/** Update a parent tool line to include a clickable link to the sub-agent post. */
function linkParentToolLine(
  parentState: WatchState,
  parentToolUseId: string,
  subagentChannelId: string,
): void {
  const frag = findToolFragment(parentState, parentToolUseId);
  if (!frag) return;

  const guildId = activeConfig?.guildId ?? '';
  const link = `https://discord.com/channels/${guildId}/${subagentChannelId}`;

  // Match pattern: (icon **name** optional-badge)  (description)  (status)
  const match = frag.text.match(/^(.+\*\*\s*)(.+?)(\s+[⏳✓✗])$/);
  if (match) {
    frag.text = `${match[1]}[\u{2192} ${match[2]}](${link})${match[3]}`;
  }

  // Re-render the content section containing this fragment
  const sectionId = parentState.toolIndex.get(parentToolUseId);
  if (sectionId) {
    const cs = parentState.contentSections.find(s => s.sectionId === sectionId);
    if (cs) syncContentToBuffer(cs, parentState.buffer);
  }
}

/** Check if a watch state represents a sub-agent post. */
function isSubagentPost(state: WatchState): boolean {
  return state.parentSessionId != null;
}

/** Add a ✅ reaction to the last message in a sub-agent post for manual cleanup. */
async function addCleanupReaction(state: WatchState): Promise<void> {
  const last = getLastSection(state.buffer);
  if (!last) return;
  const lastMessageId = state.projection.sectionToMessageId.get(last.id);
  if (!lastMessageId) return;
  await addReaction(state.discordChannelId, lastMessageId, '\u{2705}');
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

/** Truncate at the last newline before the limit, so we don't cut mid-line. */
function truncateAtNewline(str: string, max: number): string {
  if (str.length <= max) return str;
  const breakPoint = str.lastIndexOf('\n', max);
  if (breakPoint > max * 0.5) {
    return str.slice(0, breakPoint);
  }
  return str.slice(0, max - 3) + '...';
}

