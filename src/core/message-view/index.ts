/**
 * Message View — Forum-post-based Discord bot orchestration
 *
 * Lifecycle management and Gateway routing. Watch state is in watch-state.ts;
 * forum management is in forum.ts; rendering is in render.ts; command handling
 * is in commands.ts.
 *
 * @module message-view/index
 */

import { log } from '../log.js';
import { onSettingsChanged, getSettingsSnapshotInternal } from '../settings/index.js';
import { subscribeSessionList, unsubscribeSessionList } from '../session-list-manager.js';
import type { SessionListSubscriber } from '../session-list-manager.js';
import type { SessionListEvent } from '../session-list-events.js';
import {
  initTransport,
  shutdownTransport,
  archiveThread,
  connectGateway,
  disconnectGateway,
  getBotUserId,
  discordFetch,
  triggerTyping,
} from './discord-transport.js';
import type { GatewayEventHandler } from './discord-transport.js';
import type { DiscordProviderConfig } from './config.js';
import { handleCommand } from './commands.js';
import type { CommandContext } from './commands.js';
import { ensureForumChannel, rejoinForumThreads, ensureHealthThread } from './forum.js';
import { sendMessage } from './discord-transport.js';
import {
  hasWatch,
  getWatch,
  getSessionForChannel,
  isCommandSession,
  addCommandSession,
  clearCommandSessions,
  watchCount,
  allWatches,
  disposeWatch,
  disposeAllWatches,
  resolveReactionApproval,
  syncSession,
  watchSession,
  createWatchedSession,
  handlePostMessage,
} from './watch-state.js';

// Re-export pure functions for testing
export { renderSession, splitAtNewlines } from './render.js';

const SOURCE = 'message-view';
const MAX_CONCURRENT_PROMPTS = 3;

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
let commandsEnabled = false;
let probeResolve: ((pong: string) => void) | null = null;
let probeTimeout: ReturnType<typeof setTimeout> | null = null;

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
    if (activeConfig && (
      next.token !== activeConfig.token ||
      next.guildId !== activeConfig.guildId ||
      next.sessions !== activeConfig.sessions ||
      next.permissionMode !== activeConfig.permissionMode
    )) {
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
    const { settings } = getSettingsSnapshotInternal();
    const { discord } = settings;
    if (!discord.bot.enabled || !discord.bot.token || !discord.bot.guildId) return null;
    return {
      id: 'discord-bot',
      type: 'discord',
      enabled: discord.bot.enabled,
      token: discord.bot.token,
      guildId: discord.bot.guildId,
      sessions: discord.bot.sessions,
      permissionMode: discord.bot.permissionMode ?? settings.turnDefaults.permissionMode,
    };
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: 'failed to read Discord provider config', data: err });
    return null;
  }
}

function startUp(config: DiscordProviderConfig): void {
  activeConfig = config;
  startTime = Date.now();
  promptsInFlight = 0;
  forumChannelId = null;
  ownerUserId = null;
  commandsEnabled = false;
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
}

function enableAutoWatchAndHeartbeat(): void {
  if (!activeConfig) return;

  if (activeConfig.sessions === 'all') {
    const sessionListSub: SessionListSubscriber = {
      id: 'message-view-session-list',
      send(event: SessionListEvent) {
        if (event.type !== 'session_list_upsert') return;
        const session = event.session;
        if (isCommandSession(session.sessionId)) return;
        if (hasWatch(session.sessionId)) return;
        if (session.isSidechain) return;
        if (Date.now() - session.modifiedAt.getTime() > 10 * 60 * 1000) return;
        if (session.projectPath && session.projectPath !== process.cwd()) return;
        if (!forumChannelId) return;
        void watchSession(session.sessionId, forumChannelId, { auto: true },
          activeConfig?.permissionMode ?? null).catch(err => {
          log({ source: SOURCE, level: 'error', summary: `auto-watch failed for ${session.sessionId.slice(0, 8)}`, data: err });
        });
      },
    };
    subscribeSessionList(sessionListSub);
    unsubSessionList = () => unsubscribeSessionList(sessionListSub);
    log({ source: SOURCE, level: 'info', summary: 'auto-watch enabled' });
  }

  heartbeatTimer = setInterval(() => {
    for (const state of allWatches()) {
      if (!state.dirty || state.syncing) continue;
      void syncSession(state).catch((err) => {
        log({ source: SOURCE, level: 'error', summary: `sync error for ${state.sessionId.slice(0, 8)}`, data: err });
      });
    }
  }, 3000);
}

function tearDown(): void {
  commandsEnabled = false;
  probeResolve = null;
  // Don't clear probeTimeout — let it fire naturally so the Promise resolves.
  // Clearing it would strand the probeLeadership() Promise forever.

  if (unsubSessionList) {
    unsubSessionList();
    unsubSessionList = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  disposeAllWatches();
  clearCommandSessions();
  disconnectGateway();
  activeConfig = null;
  forumChannelId = null;
  ownerUserId = null;
  promptsInFlight = 0;
  shutdownTransport();
}

// ---------------------------------------------------------------------------
// Forum Channel Init
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
  const activeThreads = await rejoinForumThreads(activeConfig.guildId, forumChannelId);

  // --- PROBE PHASE ---
  const healthThreadId = await ensureHealthThread(forumChannelId, activeThreads);

  // Random delay (0-2s) to reduce simultaneous-startup split-brain risk
  await new Promise(r => setTimeout(r, Math.random() * 2000));
  if (!activeConfig) return;

  const pong = await probeLeadership(healthThreadId);
  if (!activeConfig) return;
  if (pong) {
    log({ source: SOURCE, level: 'warn', summary: `Another Crispy instance already active (${pong}) — disconnecting Discord` });
    tearDown();
    return;
  }

  // Claim leadership — announce immediately so late-starting instances
  // still in their probe window see the pong and back off.
  commandsEnabled = true;
  enableAutoWatchAndHeartbeat();
  void handleCommand(healthThreadId, '!crispy', buildCommandContext());
  log({ source: SOURCE, level: 'info', summary: 'Discord bot active — commands enabled' });
}

function probeLeadership(threadId: string): Promise<string | null> {
  return new Promise((resolve) => {
    probeResolve = (pong) => {
      if (probeTimeout) { clearTimeout(probeTimeout); probeTimeout = null; }
      resolve(pong);
    };
    sendMessage(threadId, '!crispy').catch(() => {
      probeResolve = null;
      resolve(null);
    });
    probeTimeout = setTimeout(() => {
      probeResolve = null;
      probeTimeout = null;
      resolve(null);
    }, 3000);
  });
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
  if (!botId) return;

  // Bot-self messages: handle probe protocol, drop everything else
  if (message.author.id === botId) {
    // Leader responds to !crispy probes from other instances
    if (commandsEnabled && message.content.trim() === '!crispy') {
      void handleCommand(channelId, '!crispy', buildCommandContext());
      return;
    }
    // Probing instance captures pong from leader
    if (probeResolve && message.content.startsWith('crispy-pong')) {
      const resolve = probeResolve;
      probeResolve = null;
      resolve(message.content);
    }
    return;
  }

  // Commands are gated on commandsEnabled
  if (!commandsEnabled) return;

  // Route 1: message in a session post -> follow-up turn
  if (getSessionForChannel(channelId)) {
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
    permissionMode: activeConfig?.permissionMode ?? null,
    uptimeMs: () => Date.now() - startTime,
    watchedCount: () => watchCount(),
    isWatching: (id) => hasWatch(id),
    getWatchDiscordChannelId: (id) => getWatch(id)?.discordChannelId,
    acquirePromptSlot: () => {
      if (promptsInFlight >= MAX_CONCURRENT_PROMPTS) return false;
      promptsInFlight++;
      return true;
    },
    releasePromptSlot: () => { promptsInFlight--; },
    createSession: (vendor, prompt) => {
      if (!activeConfig || !forumChannelId) throw new Error('Forum channel not ready');
      return createWatchedSession(vendor, prompt, forumChannelId, activeConfig.guildId,
        activeConfig.permissionMode ?? null);
    },
    openSession: (id) => {
      if (!forumChannelId) throw new Error('Forum channel not ready');
      return watchSession(id, forumChannelId, { auto: false },
        activeConfig?.permissionMode ?? null);
    },
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
    const sessionId = getSessionForChannel(channelId);
    if (sessionId) disposeWatch(sessionId);
    archiveThread(channelId).catch((err) => {
      log({ source: SOURCE, level: 'debug', summary: `archive on \u{274C} failed for ${channelId}`, data: err });
    });
    log({ source: SOURCE, level: 'info', summary: `\u{274C} reaction — archived thread ${channelId}` });
    return;
  }

  resolveReactionApproval(channelId, messageId, userId, emoji);
}
