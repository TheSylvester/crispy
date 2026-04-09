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
import type { SessionSnapshot } from '../session-snapshot.js';
import type { MessageProvider, ViewOpts } from './provider.js';
import type { DiscordProviderConfig } from './config.js';
import type { AgentDispatch } from '../agent-dispatch-types.js';
import type { Vendor } from '../transcript.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { normalizePath } from '../url-path-resolver.js';
import {
  initTransport,
  shutdownTransport,
  connectGateway,
  disconnectGateway,
  getBotUserId,
  discordFetch,
  triggerTyping,
  sendMessage,
  sendMessageWithComponents,
  respondToInteraction,
  archiveThread,
} from './discord-transport.js';
import type { GatewayEventHandler, DiscordInteraction } from './discord-transport.js';
import { handleCommand, handleSessionButtonPick, handleSessionNextButton, disposeAllScreens, resetBotChannel } from './commands.js';
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
  resolveButtonApproval,
  buildCloseButton,
  drainOne,
  watchSession,
  watchSessionInThread,
  createWatchedSession,
  handlePostMessage,
  trackUserMessage,
} from './watch-state.js';

const SOURCE = 'discord-provider';
const MAX_CONCURRENT_PROMPTS = 3;
const DEFAULT_ARCHIVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

const TOOLBAR_MESSAGE = '\u{1F7E2} **Crispy online.**\n\nBrowse sessions, add a workspace, or reset this channel.';

function buildToolbarComponents(): import('./discord-transport.js').MessageComponent[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Browse Sessions', custom_id: 'browse_sessions', emoji: { name: '\u{1F4C2}' } },
      { type: 2, style: 2, label: 'Add Workspace', custom_id: 'add_workspace', emoji: { name: '\u{1F4C1}' } },
      { type: 2, style: 4, label: 'Reset', custom_id: 'reset_channel', emoji: { name: '\u{1F504}' } },
    ],
  }];
}

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
let currentConfig: DiscordProviderConfig | null = null;
let currentDispatch: AgentDispatch | null = null;
let workspaceCwd: string | null = null;
let botControlChannelId: string | null = null;
let toolbarMessageId: string | null = null;
/** Prevents concurrent workspace creation for the same path. */
const pendingWorkspaceCreations = new Set<string>();
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
  return getForumForWorkspace(workspaceCwd ?? homedir());
}

/** Find the workspace cwd that matches a session's projectPath. */
function findWorkspaceCwd(projectPath: string | undefined): string | null {
  if (!projectPath) return null;
  const normalized = normalizePath(projectPath);
  // Exact match first
  if (workspaceChannels.has(normalized)) return normalized;
  // Fallback: find by normalized key comparison
  for (const cwd of workspaceChannels.keys()) {
    if (normalizePath(cwd) === normalized) return cwd;
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
    onInteraction(interaction) {
      handleGatewayInteraction(interaction).catch((err) => {
        log({ source: SOURCE, level: 'error', summary: 'interaction handler error', data: err });
      });
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
      // which are called through the command context.
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

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  disposeAllWatches();
  clearCommandSessions();
  disposeAllScreens();
  lastTypingFired.clear();
  channelMap.clear();
  lastActivityMap.clear();
  disconnectGateway();
  currentConfig = null;
  currentDispatch = null;
  workspaceCwd = null;
  botControlChannelId = null;
  toolbarMessageId = null;
  pendingWorkspaceCreations.clear();

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

  const welcomeMsg = await sendMessageWithComponents(
    botControlChannelId, TOOLBAR_MESSAGE, buildToolbarComponents(),
  );
  toolbarMessageId = welcomeMsg.id;


  commandsEnabled = true;
  enableHeartbeat();

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

  // If we already track this channel, it's bot-created — skip
  if (channelMap.has(event.id)) return;
  if (getSessionForChannel(event.id)) return;

  // Check if the thread name looks bot-created (session-XXXXXXXX format)
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
  const cwd = getWorkspaceForForum(forumChannelId) ?? workspaceCwd ?? homedir();

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

  // First bot message: session ID anchor + close button
  await sendMessageWithComponents(threadId, `session-${sessionId.slice(0, 8)}`, buildCloseButton(sessionId)).catch(() => {
    sendMessage(threadId, `session-${sessionId.slice(0, 8)}`).catch(() => {});
  });

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
// Heartbeat
// ---------------------------------------------------------------------------

function enableHeartbeat(): void {
  if (!currentConfig) return;

  const intervalMs = currentConfig.heartbeatIntervalMs ?? 1500;

  heartbeatTimer = setInterval(() => {
    const now = Date.now();

    for (const state of allWatches()) {
      if (!lastActivityMap.has(state.discordChannelId)) {
        lastActivityMap.set(state.discordChannelId, now);
      }

      // Typing indicator (unchanged — still needs its own cooldown)
      if (state.snapshot.status === 'working') {
        const last = lastTypingFired.get(state.discordChannelId) ?? 0;
        if (now - last >= TYPING_COOLDOWN_MS) {
          lastTypingFired.set(state.discordChannelId, now);
          triggerTyping(state.discordChannelId).catch(() => {});
        }
      }

      // Drain: skip if cooling down from error/429
      if (state.cooldownUntil && now < state.cooldownUntil) continue;

      // Burst mode: catchup sets burstRemaining to allow multiple ops per tick.
      // Steady state: burstRemaining is 0 → runs drainOne once.
      const opsThisTick = Math.max(1, state.burstRemaining);
      state.burstRemaining = 0;

      void (async () => {
        for (let i = 0; i < opsThisTick; i++) {
          // Re-check cooldown between iterations — handleDrainError may have
          // set it during a previous iteration in this burst.
          if (state.cooldownUntil && Date.now() < state.cooldownUntil) break;
          const moreWork = await drainOne(state);
          if (moreWork) {
            lastActivityMap.set(state.discordChannelId, now);
          }
          if (!moreWork) break;
        }
      })().catch((err) => {
        log({ source: SOURCE, level: 'error', summary: `drain error for ${state.sessionId.slice(0, 8)}`, data: err });
      });
    }

    checkArchival();
  }, intervalMs);
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

async function handleGatewayInteraction(interaction: DiscordInteraction): Promise<void> {
  // Extract user ID (guild = member.user.id, DM = user.id)
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!userId || !isAuthorized(userId)) {
    await respondToInteraction(interaction.id, interaction.token, {
      type: 4,
      data: { content: '\u{274C} Not authorized.', flags: 64 },
    });
    return;
  }

  // Modal submissions (type 5) — route by custom_id
  if (interaction.type === 5) {
    const customId = interaction.data?.custom_id;
    if (customId === 'add_workspace_modal') {
      await handleAddWorkspaceModal(interaction);
    } else {
      await respondToInteraction(interaction.id, interaction.token, { type: 6 });
    }
    return;
  }

  const customId = interaction.data?.custom_id;
  if (!customId) {
    await respondToInteraction(interaction.id, interaction.token, { type: 6 });
    return;
  }

  // Route by prefix
  if (customId.startsWith('approve:')) {
    await handleApprovalInteraction(interaction, customId);
  } else if (customId === 'browse_sessions') {
    await respondToInteraction(interaction.id, interaction.token, { type: 6 });
    await handleCommand(interaction.channel_id, '!sessions', buildCommandContext());
  } else if (customId === 'add_workspace') {
    // Open modal with text input for workspace path
    await respondToInteraction(interaction.id, interaction.token, {
      type: 9, // MODAL
      data: {
        custom_id: 'add_workspace_modal',
        title: 'Add Workspace',
        components: [{
          type: 1, // ActionRow
          components: [{
            type: 4, // TextInput
            custom_id: 'workspace_path',
            label: 'Workspace Path',
            style: 1, // Short
            placeholder: '/home/user/dev/my-project',
            required: true,
          }],
        }],
      },
    });
  } else if (customId === 'reset_channel') {
    await respondToInteraction(interaction.id, interaction.token, { type: 6 });
    await handleResetChannel(interaction.channel_id);
  } else if (customId.startsWith('close:')) {
    const sessionId = customId.slice(6);
    const fallbackSessionId = getSessionForChannel(interaction.channel_id);
    const watchState = getWatch(sessionId) ?? (fallbackSessionId ? getWatch(fallbackSessionId) : undefined);
    const displayId = (watchState?.sessionId ?? sessionId).slice(0, 8);
    // Respond first (before archive, which could race with the response)
    await respondToInteraction(interaction.id, interaction.token, {
      type: 7,
      data: {
        content: `session-${displayId} \u{2014} \u{1F512} closed`,
        components: [],
      },
    });
    if (watchState) {
      disposeWatch(watchState.sessionId);
    } else {
      archiveThread(interaction.channel_id).catch(() => {});
    }
    // Clean up provider-level bookkeeping (disposeWatch only clears watch-state maps)
    channelMap.delete(interaction.channel_id);
    lastActivityMap.delete(interaction.channel_id);
  } else if (customId.startsWith('session:') || customId.startsWith('session_next:')) {
    // Ack immediately — opening a session can exceed the 3-second deadline
    await respondToInteraction(interaction.id, interaction.token, { type: 6 });
    if (customId.startsWith('session_next:')) {
      await handleSessionNextButton(customId, interaction.message?.id ?? '', buildCommandContext());
    } else {
      await handleSessionPickInteraction(interaction, customId);
    }
  } else {
    // Unknown custom_id — ack to prevent Discord "interaction failed" error
    await respondToInteraction(interaction.id, interaction.token, { type: 6 });
  }
}

async function handleApprovalInteraction(interaction: DiscordInteraction, customId: string): Promise<void> {
  const parts = customId.split(':');
  const toolUseId = parts[1];
  const optionId = parts.slice(2).join(':'); // Rejoin in case optionId contains colons
  if (!toolUseId || !optionId) {
    await respondToInteraction(interaction.id, interaction.token, { type: 6 });
    return;
  }

  const resolved = resolveButtonApproval(interaction.channel_id, toolUseId, optionId);
  if (resolved) {
    await respondToInteraction(interaction.id, interaction.token, {
      type: 7, // UPDATE_MESSAGE
      data: {
        content: `${resolved.emoji} **${resolved.toolName}** \u{2014} ${resolved.label}`,
        components: [], // Remove buttons
      },
    });
  } else {
    await respondToInteraction(interaction.id, interaction.token, {
      type: 4,
      data: { content: '\u{26A0}\u{FE0F} This approval has expired.', flags: 64 },
    });
  }
}

async function handleSessionPickInteraction(interaction: DiscordInteraction, customId: string): Promise<void> {
  const messageId = interaction.message?.id ?? '';
  const picked = handleSessionButtonPick(customId, messageId);
  if (!picked) {
    await sendMessage(interaction.channel_id, '\u{26A0}\u{FE0F} This session list has expired. Use `!sessions` to refresh.').catch(() => {});
    return;
  }

  const ctx = buildCommandContext();

  if (ctx.isWatching(picked.sessionId)) {
    const discordChannelId = ctx.getWatchDiscordChannelId(picked.sessionId);
    const link = `https://discord.com/channels/${ctx.guildId}/${discordChannelId}`;
    await sendMessage(interaction.channel_id, `Already open: ${link}`).catch(() => {});
    return;
  }

  await sendMessage(interaction.channel_id, `\u{23F3} Opening **${picked.title.slice(0, 50)}**\u{2026}`).catch(() => {});

  try {
    await ctx.openSession(picked.sessionId);
    const discordChannelId = ctx.getWatchDiscordChannelId(picked.sessionId);
    if (discordChannelId) {
      const link = `https://discord.com/channels/${ctx.guildId}/${discordChannelId}`;
      await sendMessage(interaction.channel_id, `\u{2705} Opened: ${link}`).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(interaction.channel_id, `\u{274C} Failed to open: ${msg}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Add Workspace Modal Handler
// ---------------------------------------------------------------------------

async function handleAddWorkspaceModal(interaction: DiscordInteraction): Promise<void> {
  const rawPath = interaction.data?.components?.[0]?.components?.[0]?.value?.trim();
  const workspacePath = rawPath ? normalizePath(resolvePath(rawPath)) : null;
  if (!workspacePath) {
    await respondToInteraction(interaction.id, interaction.token, {
      type: 4,
      data: { content: '\u{274C} No path provided.', flags: 64 },
    });
    return;
  }

  // Check for duplicate workspace or in-flight creation
  if (workspaceChannels.has(workspacePath)) {
    const existing = workspaceChannels.get(workspacePath)!;
    await respondToInteraction(interaction.id, interaction.token, {
      type: 4,
      data: {
        content: `\u{1F4C1} Workspace already exists: <#${existing.channelId}>`,
        flags: 64,
      },
    });
    return;
  }
  if (pendingWorkspaceCreations.has(workspacePath)) {
    await respondToInteraction(interaction.id, interaction.token, {
      type: 4,
      data: { content: `\u{23F3} Workspace creation already in progress for this path.`, flags: 64 },
    });
    return;
  }

  if (!existsSync(workspacePath)) {
    await respondToInteraction(interaction.id, interaction.token, {
      type: 4,
      data: { content: `\u{274C} Path not found: \`${workspacePath}\``, flags: 64 },
    });
    return;
  }

  // Ack with deferred reply — channel creation may take a moment
  await respondToInteraction(interaction.id, interaction.token, {
    type: 4,
    data: { content: `\u{23F3} Creating workspace for \`${workspacePath}\`\u{2026}` },
  });

  pendingWorkspaceCreations.add(workspacePath);
  try {
    const guildId = currentConfig!.guildId;
    const botId = getBotUserId()!;
    const channel = await createWorkspaceChannel(guildId, botId, ownerUserId, workspacePath, process.pid);
    registerWorkspaceChannel(workspacePath, channel);
    log({ source: SOURCE, level: 'info', summary: `dynamic workspace created: ${channel.channelName} (${channel.channelId})` });

    // Edit the deferred reply with success
    await discordFetch('PATCH', `/webhooks/${getBotUserId()}/${interaction.token}/messages/@original`, {
      content: `\u{2705} Workspace created: <#${channel.channelId}> for \`${workspacePath}\``,
    }).catch(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await discordFetch('PATCH', `/webhooks/${getBotUserId()}/${interaction.token}/messages/@original`, {
      content: `\u{274C} Failed to create workspace: ${msg}`,
    }).catch(() => {});
  } finally {
    pendingWorkspaceCreations.delete(workspacePath);
  }
}

// ---------------------------------------------------------------------------
// Reset Channel Handler
// ---------------------------------------------------------------------------

async function handleResetChannel(channelId: string): Promise<void> {
  if (!channelId) return;
  await resetBotChannel(channelId, buildCommandContext());
}

// ---------------------------------------------------------------------------
// Dynamic Workspace Creation — auto-create forum for unknown project paths
// ---------------------------------------------------------------------------

async function ensureWorkspaceForSession(projectPath: string | undefined): Promise<string | null> {
  const cwd = findWorkspaceCwd(projectPath);
  if (cwd) return workspaceChannels.get(cwd)?.channelId ?? null;

  if (!projectPath) return getPrimaryForumChannelId();
  if (!currentConfig || !getBotUserId()) return getPrimaryForumChannelId();

  const normalized = normalizePath(projectPath);

  // Guard against concurrent creation for the same path
  if (pendingWorkspaceCreations.has(normalized)) return getPrimaryForumChannelId();

  pendingWorkspaceCreations.add(normalized);
  try {
    // Re-check after acquiring the guard (another call may have completed)
    if (workspaceChannels.has(normalized)) return workspaceChannels.get(normalized)!.channelId;

    const channel = await createWorkspaceChannel(
      currentConfig.guildId, getBotUserId()!, ownerUserId, normalized, process.pid,
    );
    registerWorkspaceChannel(normalized, channel);
    log({ source: SOURCE, level: 'info', summary: `auto-created workspace for ${normalized}: ${channel.channelName}` });
    return channel.channelId;
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: `failed to auto-create workspace for ${normalized}`, data: err });
    return getPrimaryForumChannelId();
  } finally {
    pendingWorkspaceCreations.delete(normalized);
  }
}

// ---------------------------------------------------------------------------
// Command Context
// ---------------------------------------------------------------------------

function buildCommandContext(): CommandContext {
  const primaryForumId = getPrimaryForumChannelId();
  return {
    guildId: currentConfig?.guildId ?? null,
    permissionMode: currentConfig?.permissionMode ?? null,
    dispatch: currentDispatch,
    toolbarMessageId,
    uptimeMs: () => Date.now() - startTime,
    watchedCount: () => watchCount(),
    isWatching: (id) => hasWatch(id),
    getWatchDiscordChannelId: (id) => getWatch(id)?.discordChannelId,
    openSession: async (id, forumChannelId) => {
      let targetForumId = forumChannelId ?? null;
      if (!targetForumId) {
        // Look up session's projectPath for dynamic workspace creation
        const sessionInfo = await currentDispatch?.findSession(id);
        targetForumId = await ensureWorkspaceForSession(sessionInfo?.projectPath) ?? primaryForumId;
      }
      if (!targetForumId) throw new Error('Forum channel not ready');
      return watchSession(id, targetForumId, {},
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
