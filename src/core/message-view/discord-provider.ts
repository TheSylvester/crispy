/**
 * Discord Provider — Discord-specific MessageProvider implementation
 *
 * Owns the Gateway connection, heartbeat loop, workspace-scoped forum channel
 * lifecycle, command handling, approval interactions, and sync loop.
 *
 * Lifecycle: selective wipe on startup. Each bot wipes its own PID channels,
 * health-checks other bots' channels (sends `!status`, waits 3s for response),
 * and deletes dead bots' channels. Live bots' channels are left alone.
 *
 * Workspace model: each forum channel maps to a project directory (workspace).
 * Channel naming: `crispy-{project}-{pid}`. The provider maintains a map
 * from cwd → forumChannelId.
 *
 * Interaction: users create forum posts to start sessions, or use `!sessions`
 * in the bot control channel to open existing ones. The bot channel also
 * accepts plain-text commands (no @mention required).
 *
 * @module message-view/discord-provider
 */

import { log } from '../log.js';
import { isChildSession } from '../session-manager.js';
import { subscribeSessionList, unsubscribeSessionList } from '../session-list-manager.js';
import type { SessionListSubscriber } from '../session-list-manager.js';
import type { SessionListEvent } from '../session-list-events.js';
import type { SessionSnapshot } from '../session-snapshot.js';
import type { MessageProvider, ViewOpts } from './provider.js';
import type { DiscordProviderConfig } from './config.js';
import type { AgentDispatch } from '../agent-dispatch-types.js';
import type { Vendor } from '../transcript.js';
import {
  initTransport,
  shutdownTransport,
  connectGateway,
  disconnectGateway,
  getBotUserId,
  discordFetch,
  triggerTyping,
  sendMessage,
  addReaction,
  archiveThread,
} from './discord-transport.js';
import type { GatewayEventHandler } from './discord-transport.js';
import { handleCommand, handleSessionListReaction } from './commands.js';
import type { CommandContext } from './commands.js';
import {
  cleanupAndDiscoverBots,
  wipeChannelsForPids,
  createWorkspaceChannel,
  createBotChannel,
  cwdToBaseProject,
  type WorkspaceChannel,
} from './forum.js';
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
  watchSessionInThread,
  createWatchedSession,
  handlePostMessage,
  trackUserMessage,
} from './watch-state.js';

const SOURCE = 'discord-provider';
const MAX_CONCURRENT_PROMPTS = 3;
const DEFAULT_ARCHIVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Provider state — singleton: only one Discord provider may exist at a time.
// Module-level state assumes exclusive ownership. The shared layer enforces
// this by calling tearDown() (which disposes the existing provider) before
// creating a new one.
// ---------------------------------------------------------------------------

/** Workspace-to-channel map: cwd → { channelId, project } */
const workspaceChannels = new Map<string, WorkspaceChannel>();
/** Reverse lookup: forumChannelId → cwd */
const channelToWorkspace = new Map<string, string>();
/** Discord thread → session ID (single source of truth for all tracked posts) */
const channelMap = new Map<string, string>();
/** Last activity timestamp per Discord thread (for archival) */
const lastActivityMap = new Map<string, number>();

let ownerUserId: string | null = null;
let commandsEnabled = false;

/**
 * Authorization check — fail-closed.
 * Owner (via OAuth) always passes. Allowlist is additive (expands access
 * beyond owner). If no owner AND no allowlist, nobody can interact.
 */
function isAuthorized(userId: string): boolean {
  if (ownerUserId && userId === ownerUserId) return true;
  if (currentConfig?.allowedUserIds?.length) {
    return currentConfig.allowedUserIds.includes(userId);
  }
  return false;
}
let promptsInFlight = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let startTime = 0;
let unsubSessionList: (() => void) | null = null;
let currentConfig: DiscordProviderConfig | null = null;
let currentDispatch: AgentDispatch | null = null;
let workspaceCwd: string | null = null;
let botControlChannelId: string | null = null;
let welcomeMessageId: string | null = null;
const lastTypingFired = new Map<string, number>();
const TYPING_COOLDOWN_MS = 8000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;

/** Pending health check resolvers keyed by channel ID. Set during startup, cleared after. */
const healthCheckResolvers = new Map<string, (content: string) => void>();

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

/** Get the forum channel ID for a workspace cwd. */
function getForumForWorkspace(cwd: string): string | null {
  return workspaceChannels.get(cwd)?.channelId ?? null;
}

/** Get the forum channel ID for the primary workspace. */
function getPrimaryForumChannelId(): string | null {
  return getForumForWorkspace(workspaceCwd ?? process.cwd());
}

/** Find the workspace cwd that matches a session's projectPath. */
function findWorkspaceCwd(projectPath: string | undefined): string | null {
  if (!projectPath) return null;
  // Exact match first
  if (workspaceChannels.has(projectPath)) return projectPath;
  // Fallback: find by matching basename
  for (const cwd of workspaceChannels.keys()) {
    if (projectPath === cwd) return cwd;
  }
  return null;
}

/** Get the forum channel ID for a session's project path, falling back to primary. */
function getForumForSession(projectPath: string | undefined): string | null {
  const cwd = findWorkspaceCwd(projectPath);
  if (cwd) return workspaceChannels.get(cwd)?.channelId ?? null;
  return getPrimaryForumChannelId();
}

/** Get the workspace cwd associated with a forum channel. */
function getWorkspaceForForum(forumChannelId: string): string | null {
  return channelToWorkspace.get(forumChannelId) ?? null;
}

/** Check if a forum channel is a workspace forum we manage. */
function isWorkspaceForum(forumChannelId: string): boolean {
  return channelToWorkspace.has(forumChannelId);
}

/** Check if any workspace forum is ready. */
function hasAnyForum(): boolean {
  return workspaceChannels.size > 0;
}

function registerWorkspaceChannel(cwd: string, wc: WorkspaceChannel): void {
  workspaceChannels.set(cwd, wc);
  channelToWorkspace.set(wc.channelId, cwd);
}

function clearWorkspaceChannels(): void {
  workspaceChannels.clear();
  channelToWorkspace.clear();
}

// ---------------------------------------------------------------------------
// Vendor prefix parsing
// ---------------------------------------------------------------------------

const KNOWN_VENDORS = ['claude', 'codex', 'gemini'];

function parseVendorPrefix(text: string): string | null {
  const match = text.match(/^(\w+):\s/);
  if (!match) return null;
  const candidate = match[1].toLowerCase();
  if (KNOWN_VENDORS.includes(candidate)) return candidate;
  return null;
}

// ---------------------------------------------------------------------------
// Provider creation
// ---------------------------------------------------------------------------

export function createDiscordProvider(
  config: DiscordProviderConfig,
  dispatch: AgentDispatch,
  cwd?: string,
): MessageProvider {
  currentConfig = config;
  currentDispatch = dispatch;
  workspaceCwd = cwd ?? null;
  startTime = Date.now();
  promptsInFlight = 0;
  clearWorkspaceChannels();
  channelMap.clear();
  lastActivityMap.clear();
  ownerUserId = null;
  commandsEnabled = false;

  initTransport(config.token);
  log({ source: SOURCE, level: 'info', summary: 'discord provider starting — connecting Gateway' });

  const handler: GatewayEventHandler = {
    onMessage(channelId, message) {
      handleGatewayMessage(channelId, message).catch((err) => {
        log({ source: SOURCE, level: 'error', summary: 'gateway message handler error', data: err });
      });
    },
    onReactionAdd(channelId, messageId, userId, emoji) {
      handleGatewayReaction(channelId, messageId, userId, emoji);
    },
    onThreadCreate(event) {
      handleThreadCreate(event);
    },
    onReady() {
      log({ source: SOURCE, level: 'info', summary: 'Gateway ready — discovering workspace channels' });
      initWorkspaceChannels().catch((err) => {
        log({ source: SOURCE, level: 'error', summary: 'workspace channel setup failed', data: err });
      });
    },
  };

  connectGateway(handler).catch((err) => {
    log({ source: SOURCE, level: 'error', summary: 'Gateway connection failed', data: err });
  });

  return {
    id: config.id,

    onSnapshotChanged(sessionId: string, _snapshot: SessionSnapshot): void {
      // Track activity for archival
      for (const [threadId, sid] of channelMap) {
        if (sid === sessionId) {
          lastActivityMap.set(threadId, Date.now());
          // Unarchive if the thread was archived
          void unarchiveIfNeeded(threadId);
          break;
        }
      }
    },

    async createSessionView(_sessionId: string, _prompt: string, _opts: ViewOpts): Promise<void> {
      // Session views are created via createWatchedSession / watchSession
      // which are called through the command context or auto-watch.
    },

    dispose(): void {
      disposeDiscordProvider();
    },
  };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function disposeDiscordProvider(): void {
  commandsEnabled = false;

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
  lastTypingFired.clear();
  channelMap.clear();
  lastActivityMap.clear();
  disconnectGateway();
  currentConfig = null;
  currentDispatch = null;
  workspaceCwd = null;
  botControlChannelId = null;
  welcomeMessageId = null;
  clearWorkspaceChannels();
  ownerUserId = null;
  promptsInFlight = 0;
  shutdownTransport();
}

// ---------------------------------------------------------------------------
// Workspace Channel Init
// ---------------------------------------------------------------------------

async function initWorkspaceChannels(): Promise<void> {
  if (!currentConfig) return;
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

  const guildId = currentConfig.guildId;
  const myPid = process.pid;

  // Step 1: Wipe own PID channels + discover other bots (single API call)
  const { otherBots, channels } = await cleanupAndDiscoverBots(guildId, myPid);

  // Step 2: Health-check other bots' channels (parallel — max wait is one timeout)
  if (otherBots.length > 0) {
    log({ source: SOURCE, level: 'info', summary: `health-checking ${otherBots.length} other bot channel(s)` });
    const results = await Promise.allSettled(otherBots.map(bot => healthCheckBot(bot.id)));
    const deadPids = new Set<number>();

    for (let i = 0; i < otherBots.length; i++) {
      const alive = results[i].status === 'fulfilled' && (results[i] as PromiseFulfilledResult<boolean>).value;
      if (!alive) {
        log({ source: SOURCE, level: 'info', summary: `bot PID ${otherBots[i].pid} (${otherBots[i].name}) is dead — marking for cleanup` });
        deadPids.add(otherBots[i].pid);
      } else {
        log({ source: SOURCE, level: 'info', summary: `bot PID ${otherBots[i].pid} (${otherBots[i].name}) is alive — leaving channels` });
      }
    }

    // Step 3: Bulk-delete dead bots' channels (reuse pre-fetched list)
    if (deadPids.size > 0) {
      await wipeChannelsForPids(guildId, deadPids, channels);
    }
  }
  healthCheckResolvers.clear();

  // Step 4: Create fresh channels
  if (workspaceCwd) {
    const channel = await createWorkspaceChannel(guildId, botId, ownerUserId, workspaceCwd, myPid);
    registerWorkspaceChannel(workspaceCwd, channel);
    log({ source: SOURCE, level: 'info', summary: `workspace forum ready: ${channel.channelName} (${channel.channelId})` });
  } else {
    log({ source: SOURCE, level: 'warn', summary: 'no workspace cwd — bot will connect but skip workspace channel creation' });
  }

  botControlChannelId = await createBotChannel(guildId, botId, ownerUserId, myPid);

  // Post welcome message with 📂 reaction for quick session browsing
  const welcomeMsg = await sendMessage(botControlChannelId, [
    '\u{1F7E2} **Crispy online.**',
    '',
    'React \u{1F4C2} to browse sessions, or create a **New Post** in the forum channel.',
  ].join('\n'));
  welcomeMessageId = welcomeMsg.id;
  await addReaction(botControlChannelId, welcomeMsg.id, '\u{1F4C2}').catch(() => {});

  commandsEnabled = true;
  enableAutoWatchAndHeartbeat();

  log({ source: SOURCE, level: 'info', summary: `Discord bot active — commands enabled, ${workspaceChannels.size} workspace(s)` });
}


// ---------------------------------------------------------------------------
// Health Check — probe another bot's control channel via !status
// ---------------------------------------------------------------------------

/**
 * Send `!status` to a bot control channel and wait for a response.
 * Returns true if the bot responds within the timeout, false otherwise.
 * Uses a one-shot Promise: the gateway message handler resolves it when a
 * bot-self message arrives in the probed channel.
 */
async function healthCheckBot(channelId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const alive = await singleHealthProbe(channelId);
    if (alive) return true;
    if (attempt === 0) {
      // Wait before retry — give the other bot time to reconnect
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return false;
}

/** Single health probe: send `!status` and wait for a response within timeout. */
function singleHealthProbe(channelId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      healthCheckResolvers.delete(channelId);
      resolve(false);
    }, HEALTH_CHECK_TIMEOUT_MS);

    healthCheckResolvers.set(channelId, () => {
      clearTimeout(timer);
      resolve(true);
    });

    sendMessage(channelId, '!status').catch(() => {
      clearTimeout(timer);
      healthCheckResolvers.delete(channelId);
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Thread Create — user-created forum posts become sessions
// ---------------------------------------------------------------------------

function handleThreadCreate(event: { id: string; parent_id: string; name: string; guild_id: string; owner_id?: string }): void {
  if (!commandsEnabled) return;

  // Auth gate: only allowed users can create sessions via forum posts.
  // Fail-closed: if owner_id is absent, deny (don't assume authorized).
  if (!event.owner_id || !isAuthorized(event.owner_id)) return;

  // Only handle threads in workspace forum channels
  if (!isWorkspaceForum(event.parent_id)) return;

  // If we already track this channel, it's bot-created or auto-watched — skip
  if (channelMap.has(event.id)) return;
  if (getSessionForChannel(event.id)) return;

  // Check if the thread name looks bot-created (session-XXXXXXXX or auto-watch format)
  // Bot-created threads from watchSession/createWatchedSession have names like
  // "session-XXXXXXXX" or the prompt text. The THREAD_CREATE fires before
  // registerWatchState completes, so channelToSession won't have it yet.
  // Delay slightly to let the createForumPost → registerWatchState chain complete.
  setTimeout(() => {
    // Re-check after a tick — the watch may have registered by now
    if (channelMap.has(event.id)) return;
    if (getSessionForChannel(event.id)) return;

    void handleUserCreatedPost(event.id, event.parent_id, event.name).catch((err) => {
      log({ source: SOURCE, level: 'error', summary: `failed to handle user-created post ${event.id}`, data: err });
    });
  }, 2000);
}

async function handleUserCreatedPost(threadId: string, forumChannelId: string, threadName?: string): Promise<void> {
  if (!currentDispatch || !currentConfig) return;

  // Fetch first message in thread (chronological order)
  const messages = await discordFetch('GET', `/channels/${threadId}/messages?limit=1&after=0`) as
    Array<{ content: string; author: { id: string } }>;
  const firstMsg = messages[0];

  // Use message body if present, otherwise fall back to thread title.
  // Discord forum posts always have a title; the body may be empty.
  const rawPrompt = (firstMsg?.content?.trim() || threadName?.trim()) ?? '';
  if (!rawPrompt) return;

  // Parse vendor prefix (e.g. "codex: fix bug")
  const vendorStr = parseVendorPrefix(rawPrompt);
  const promptText = vendorStr ? rawPrompt.slice(vendorStr.length + 2).trim() : rawPrompt;
  const vendor: Vendor = (vendorStr || 'claude') as Vendor;

  if (!promptText) return;

  // Get workspace cwd for this forum
  const cwd = getWorkspaceForForum(forumChannelId) ?? process.cwd();

  // Spawn session via AgentDispatch RPC
  const receipt = await currentDispatch.sendTurn({
    target: { kind: 'new', vendor, cwd },
    content: [{ type: 'text', text: promptText }],
    clientMessageId: crypto.randomUUID(),
    settings: buildPermissionSettings(currentConfig.permissionMode),
  });

  const sessionId = receipt.sessionId;

  // Track in channelMap
  channelMap.set(threadId, sessionId);
  lastActivityMap.set(threadId, Date.now());

  // Rename post to session display name
  let displayName = promptText.slice(0, 100).replace(/\n/g, ' ').trim();
  try {
    const sessionInfo = await currentDispatch.findSession(sessionId);
    if (sessionInfo?.title || sessionInfo?.label) {
      displayName = (sessionInfo.title ?? sessionInfo.label ?? displayName).slice(0, 100);
    }
  } catch {
    // Best effort — use prompt text as fallback
  }
  await discordFetch('PATCH', `/channels/${threadId}`, {
    name: displayName.slice(0, 100).replace(/\n/g, ' ').trim(),
  }).catch((err) => {
    log({ source: SOURCE, level: 'warn', summary: `failed to rename user-created post`, data: err });
  });

  // First bot message: session ID anchor (for crash recovery)
  await sendMessage(threadId, `\u{1F4CB} Session \`${sessionId}\``);

  // Watch in the user-created thread (no new forum post)
  const permMode = currentConfig.permissionMode ?? null;
  if (!hasWatch(sessionId)) {
    await watchSessionInThread(sessionId, threadId, permMode).catch((err) => {
      log({ source: SOURCE, level: 'warn', summary: `failed to set up watch for user-created session ${sessionId.slice(0, 8)}`, data: err });
    });
  }

  log({ source: SOURCE, level: 'info', summary: `user-created post → session ${sessionId.slice(0, 8)} (vendor=${vendor})` });
}

// ---------------------------------------------------------------------------
// Session Archival
// ---------------------------------------------------------------------------

function checkArchival(): void {
  const now = Date.now();
  const timeoutMs = (currentConfig?.archivalTimeoutHours ?? 24) * 60 * 60 * 1000;
  for (const [threadId, lastActivity] of lastActivityMap) {
    if (now - lastActivity > timeoutMs) {
      archiveThread(threadId).catch(() => {});
      lastActivityMap.delete(threadId);
      // Dispose watch if active
      const sessionId = channelMap.get(threadId);
      if (sessionId && hasWatch(sessionId)) {
        disposeWatch(sessionId);
      }
      log({ source: SOURCE, level: 'info', summary: `archived inactive thread ${threadId} (session ${channelMap.get(threadId)?.slice(0, 8) ?? 'unknown'})` });
    }
  }
}

async function unarchiveIfNeeded(threadId: string): Promise<void> {
  try {
    await discordFetch('PATCH', `/channels/${threadId}`, { archived: false });
  } catch {
    // Thread might not be archived — that's fine
  }
}

// ---------------------------------------------------------------------------
// Permission settings helper
// ---------------------------------------------------------------------------

function buildPermissionSettings(mode: string | null): Record<string, unknown> {
  if (!mode) return {};
  return {
    permissionMode: mode,
    ...(mode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
  };
}

// ---------------------------------------------------------------------------
// Auto-watch & Heartbeat
// ---------------------------------------------------------------------------

function enableAutoWatchAndHeartbeat(): void {
  if (!currentConfig) return;

  if (currentConfig.sessions === 'all') {
    const sessionListSub: SessionListSubscriber = {
      id: 'message-view-session-list',
      send(event: SessionListEvent) {
        if (event.type !== 'session_list_upsert') return;
        const session = event.session;
        if (isCommandSession(session.sessionId)) return;
        if (hasWatch(session.sessionId)) return;
        if (session.isSidechain) return;
        if (session.sessionKind === 'system') return;
        if (isChildSession(session.sessionId)) return;
        if (Date.now() - session.modifiedAt.getTime() > 10 * 60 * 1000) return;

        // Scope by workspace: session's projectPath must match a registered workspace
        const forumChannelId = getForumForSession(session.projectPath);
        if (!forumChannelId) return;

        // Verify the session belongs to a workspace we manage
        if (session.projectPath) {
          const matchedCwd = findWorkspaceCwd(session.projectPath);
          if (!matchedCwd) return;
        }

        const displayName = session.title ?? session.label ?? undefined;
        void watchSession(session.sessionId, forumChannelId, { auto: true, displayName },
          currentConfig?.permissionMode ?? null).catch(err => {
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
      // Ensure every watched session has an archival activity entry.
      // Auto-watched sessions bypass channelMap/lastActivityMap registration,
      // so seed their initial timestamp here on first encounter.
      if (!lastActivityMap.has(state.discordChannelId)) {
        lastActivityMap.set(state.discordChannelId, Date.now());
      }

      if (state.snapshot.status === 'working') {
        const now = Date.now();
        const last = lastTypingFired.get(state.discordChannelId) ?? 0;
        if (now - last >= TYPING_COOLDOWN_MS) {
          lastTypingFired.set(state.discordChannelId, now);
          triggerTyping(state.discordChannelId).catch(() => {});
        }
      }
      if (!state.dirty || state.syncing) continue;
      // Update archival activity tracking — snapshot changed for this session
      lastActivityMap.set(state.discordChannelId, Date.now());
      void syncSession(state).catch((err) => {
        log({ source: SOURCE, level: 'error', summary: `sync error for ${state.sessionId.slice(0, 8)}`, data: err });
      });
    }

    // Check for threads to archive
    checkArchival();
  }, 3000);
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

  // All instances share one bot user ID (same token), so bot-self messages
  // include messages sent by OTHER instances. Two cases need special routing:
  if (message.author.id === botId) {
    // (a) Health check: resolve pending probes, but ignore our own !status echo
    const resolver = healthCheckResolvers.get(channelId);
    if (resolver) {
      if (message.content.trim() !== '!status') {
        healthCheckResolvers.delete(channelId);
        resolver(message.content);
      }
      return;
    }
    // (b) Another instance sent a !command to our bot channel — let it through
    if (commandsEnabled && channelId === botControlChannelId && message.content.trimStart().startsWith('!')) {
      // Fall through to normal command routing below
    } else {
      return;
    }
  }

  if (!commandsEnabled) return;

  // Auth gate: only allowed users can interact.
  // Bot-self fall-through (cross-instance commands) is exempt — those
  // messages already passed the bot-self block above and are needed for
  // multi-instance health checks.
  const isBotSelf = message.author.id === botId;
  if (!isBotSelf && !isAuthorized(message.author.id)) return;

  // Route 1: message in a session post -> track + follow-up turn + update activity
  if (getSessionForChannel(channelId)) {
    // Track non-bot message for anchor detection (deduplication)
    trackUserMessage(channelId, message.id, message.content);
    // Update activity for archival tracking
    lastActivityMap.set(channelId, Date.now());
    await handlePostMessage(channelId, message);
    return;
  }

  // Route 2: DM, @mention, or bot control channel -> ! commands
  let text: string | null = null;
  if (!message.guild_id) {
    // DM — accept plain text
    text = message.content.trim();
  } else if (botControlChannelId && channelId === botControlChannelId) {
    // Bot control channel — accept plain text (no @mention needed)
    text = message.content.trim();
  } else if (message.mentions?.some(m => m.id === botId)) {
    // @mention in any guild channel — strip the mention
    text = message.content.replace(/<@!?\d+>\s*/g, '').trim();
  }

  if (text) {
    triggerTyping(channelId).catch(() => {});
    await handleCommand(channelId, text, buildCommandContext());
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

  // Auth gate: only allowed users can react
  if (!isAuthorized(userId)) return;

  // 📂 on welcome message → show session list, then remove user's reaction so they can tap again
  if (emoji === '\u{1F4C2}' && welcomeMessageId && messageId === welcomeMessageId) {
    const encoded = encodeURIComponent('\u{1F4C2}');
    void discordFetch('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/${userId}`).catch(() => {});
    void handleCommand(channelId, '!sessions', buildCommandContext()).catch((err) => {
      log({ source: SOURCE, level: 'error', summary: 'welcome reaction sessions error', data: err });
    });
    return;
  }

  // Session list reaction (numbered emoji pick or pagination)
  void handleSessionListReaction(messageId, emoji, buildCommandContext()).catch((err) => {
    log({ source: SOURCE, level: 'error', summary: 'session list reaction error', data: err });
  });

  // ❌ on any message in the forum → archive the thread (authorized users — redundant with gate above, defense-in-depth)
  if (emoji === '\u{274C}') {
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

// ---------------------------------------------------------------------------
// Command Context
// ---------------------------------------------------------------------------

function buildCommandContext(): CommandContext {
  const primaryForumId = getPrimaryForumChannelId();
  return {
    guildId: currentConfig?.guildId ?? null,
    forumReady: !!(currentConfig && hasAnyForum()),
    permissionMode: currentConfig?.permissionMode ?? null,
    dispatch: currentDispatch,
    uptimeMs: () => Date.now() - startTime,
    watchedCount: () => watchCount(),
    isWatching: (id) => hasWatch(id),
    getWatchDiscordChannelId: (id) => getWatch(id)?.discordChannelId,
    openSession: (id, forumChannelId) => {
      const targetForumId = forumChannelId ?? primaryForumId;
      if (!targetForumId) throw new Error('Forum channel not ready');
      return watchSession(id, targetForumId, { auto: false },
        currentConfig?.permissionMode ?? null);
    },
    getWorkspaceCwd: (forumChannelId) => {
      if (!forumChannelId) return null;
      return getWorkspaceForForum(forumChannelId) ?? null;
    },
    workspaceCount: () => workspaceChannels.size,
    getTrackedSessionIds: () => new Set(channelMap.values()),
  };
}
