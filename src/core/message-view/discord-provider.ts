/**
 * Discord Provider — Discord-specific MessageProvider implementation
 *
 * Owns the Gateway connection, heartbeat loop, leadership probes, workspace-
 * scoped forum channel lifecycle, command handling, approval interactions, and
 * sync loop. Receives snapshot updates from the shared layer and renders to
 * Discord.
 *
 * Workspace model: each forum channel maps to a project directory (workspace).
 * Channel naming: `crispy-{project}-{pid}`. The provider maintains a map from
 * cwd → forumChannelId and scopes auto-watch + commands per workspace.
 *
 * Forum-first interaction: users create forum posts to start sessions. The bot
 * detects THREAD_CREATE, reads the first message as the prompt, spawns a
 * session via AgentDispatch, renames the post to the session display name, and
 * embeds the session ID in the first bot message for crash recovery.
 *
 * @module message-view/discord-provider
 */

import * as path from 'node:path';
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
  archiveThread,
  getActiveThreads,
} from './discord-transport.js';
import type { GatewayEventHandler } from './discord-transport.js';
import { handleCommand } from './commands.js';
import type { CommandContext } from './commands.js';
import {
  scanWorkspaceChannels,
  ensureWorkspaceChannel,
  takeOverOrphanedChannels,
  rejoinForumThreads,
  ensureBotChannel,
  findBotChannels,
  deleteBotChannel,
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
/** Discord epoch (2015-01-01T00:00:00.000Z) used for snowflake → timestamp. */
const DISCORD_EPOCH = 1420070400000n;

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
let probeResolve: ((pong: string) => void) | null = null;
let probeTimeout: ReturnType<typeof setTimeout> | null = null;
let promptsInFlight = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let startTime = 0;
let unsubSessionList: (() => void) | null = null;
let currentConfig: DiscordProviderConfig | null = null;
let currentDispatch: AgentDispatch | null = null;
let workspaceCwd: string | null = null;
const lastTypingFired = new Map<string, number>();
const TYPING_COOLDOWN_MS = 8000;

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
  lastTypingFired.clear();
  channelMap.clear();
  lastActivityMap.clear();
  disconnectGateway();
  currentConfig = null;
  currentDispatch = null;
  workspaceCwd = null;
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

  const pid = process.pid;
  const guildId = currentConfig.guildId;

  // Workspace channel creation requires an explicit cwd. Without one
  // (e.g. dev-server launched from an unknown directory), the bot connects
  // and enables commands but has no workspace forum to manage.
  let activeThreads: Array<{ id: string; name: string; parent_id: string }> = [];

  if (workspaceCwd) {
    // Step 1: Scan guild for existing crispy-* forum channels
    const existingForums = await scanWorkspaceChannels(guildId);
    log({ source: SOURCE, level: 'info', summary: `found ${existingForums.length} existing workspace channel(s)` });

    // Step 2: Ensure workspace channel for current cwd
    const primaryChannel = await ensureWorkspaceChannel(guildId, botId, ownerUserId, workspaceCwd, pid, existingForums);
    if (!primaryChannel) {
      log({ source: SOURCE, level: 'warn', summary: 'failed to claim workspace channel — another instance won, disconnecting' });
      disposeDiscordProvider();
      return;
    }

    registerWorkspaceChannel(workspaceCwd, primaryChannel);
    log({ source: SOURCE, level: 'info', summary: `primary workspace channel ready: ${primaryChannel.channelName} (${primaryChannel.channelId})` });

    // Step 3: Rejoin threads in the primary channel
    activeThreads = await rejoinForumThreads(guildId, primaryChannel.channelId);

    // Step 4: Take over orphaned channels (PIDs that are dead)
    const ownedIds = new Set([primaryChannel.channelId]);
    const takenOver = await takeOverOrphanedChannels(pid, existingForums, ownedIds);
    for (const wc of takenOver) {
      await rejoinForumThreads(guildId, wc.channelId);
    }

    // Step 5: Crash recovery — rebuild channelMap from Discord threads
    await recoverChannelMap(guildId, primaryChannel.channelId);
    for (const wc of takenOver) {
      await recoverChannelMap(guildId, wc.channelId);
    }
  } else {
    log({ source: SOURCE, level: 'warn', summary: 'no workspace cwd — bot will connect but skip workspace channel creation' });
  }

  // --- PROBE PHASE (dedicated bot channel for leadership probes) ---
  const botChannelId = await ensureBotChannel(guildId, botId, ownerUserId, pid);

  // Random delay (0-2s) to reduce simultaneous-startup split-brain risk
  await new Promise(r => setTimeout(r, Math.random() * 2000));
  if (!currentConfig) return;

  // Probe ALL existing crispy-bot-* channels for an active leader
  const allBotChannels = await findBotChannels(guildId);
  const otherBotChannels = allBotChannels.filter(ch => ch.pid !== pid);

  for (const ch of otherBotChannels) {
    const pong = await probeLeadership(ch.id);
    if (!currentConfig) return;
    if (pong) {
      log({ source: SOURCE, level: 'warn', summary: `Another Crispy instance already active (${pong}) in ${ch.name} — disconnecting Discord` });
      // Clean up our own bot channel before backing off
      await deleteBotChannel(botChannelId).catch(() => {});
      disposeDiscordProvider();
      return;
    }
  }

  // No other leader responded — claim leadership
  // Delete stale bot channels (other PIDs that didn't respond)
  for (const ch of otherBotChannels) {
    await deleteBotChannel(ch.id).catch((err) => {
      log({ source: SOURCE, level: 'warn', summary: `failed to delete stale bot channel ${ch.name}`, data: err });
    });
  }

  // Announce presence in our own bot channel
  void handleCommand(botChannelId, '!crispy', buildCommandContext());

  // Claim leadership
  commandsEnabled = true;
  enableAutoWatchAndHeartbeat();

  // DM startup announcement to owner
  void announceStartup();

  log({ source: SOURCE, level: 'info', summary: `Discord bot active — commands enabled, ${workspaceChannels.size} workspace(s), ${channelMap.size} recovered thread(s)` });
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
// Crash Recovery — rebuild channelMap from Discord threads
// ---------------------------------------------------------------------------

/** Extract a Unix-ms timestamp from a Discord snowflake ID. */
function snowflakeToTimestamp(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH);
}

async function recoverChannelMap(guildId: string, forumChannelId: string): Promise<void> {
  const botId = getBotUserId();
  if (!botId) return;

  try {
    // Fetch active threads in guild, filter to this forum
    const active = await getActiveThreads(guildId);
    const forumThreads = active.filter(t => t.parent_id === forumChannelId);

    // Also fetch archived threads from the forum
    let archivedThreads: Array<{ id: string; parent_id: string; last_message_id?: string }> = [];
    try {
      const archived = await discordFetch('GET',
        `/channels/${forumChannelId}/threads/archived/public`
      ) as { threads?: Array<{ id: string; parent_id: string; last_message_id?: string }> };
      archivedThreads = archived.threads ?? [];
    } catch (err) {
      log({ source: SOURCE, level: 'warn', summary: 'failed to fetch archived threads for recovery', data: err });
    }

    // Deduplicate
    const seen = new Set<string>();
    const allThreads: Array<{ id: string; last_message_id?: string }> = [];
    for (const t of [...forumThreads, ...archivedThreads]) {
      if (!seen.has(t.id)) { seen.add(t.id); allThreads.push(t); }
    }

    let recovered = 0;
    for (const thread of allThreads) {
      if (channelMap.has(thread.id)) continue; // Already tracked

      try {
        // Fetch first few messages in chronological order
        const messages = await discordFetch('GET',
          `/channels/${thread.id}/messages?limit=10&after=0`
        ) as Array<{ author: { id: string }; content: string }>;

        const botMsg = messages.find(
          m => m.author.id === botId && m.content.startsWith('\u{1F4CB} Session `')
        );

        if (botMsg) {
          const match = botMsg.content.match(/Session `([^`]+)`/);
          if (match) {
            channelMap.set(thread.id, match[1]);
            // Preserve real last-activity time from the thread's most recent
            // message snowflake. Falling back to Date.now() only when the
            // snowflake is unavailable avoids resetting the inactivity clock
            // on every restart (which would prevent archival of idle threads).
            const lastActivity = thread.last_message_id
              ? snowflakeToTimestamp(thread.last_message_id)
              : Date.now();
            lastActivityMap.set(thread.id, lastActivity);
            recovered++;
          }
        }
      } catch (err) {
        log({ source: SOURCE, level: 'debug', summary: `recovery: failed to read messages from thread ${thread.id}`, data: err });
      }
    }

    if (recovered > 0) {
      log({ source: SOURCE, level: 'info', summary: `crash recovery: rebuilt ${recovered} channel mapping(s) from forum ${forumChannelId}` });
    }
  } catch (err) {
    log({ source: SOURCE, level: 'error', summary: 'crash recovery failed', data: err });
  }
}

// ---------------------------------------------------------------------------
// DM Startup Announcement
// ---------------------------------------------------------------------------

async function announceStartup(): Promise<void> {
  if (!ownerUserId) return;

  try {
    const dm = await discordFetch('POST', '/users/@me/channels', { recipient_id: ownerUserId }) as { id: string };
    const workspaces = [...workspaceChannels.entries()];
    const lines = workspaces.map(([cwd]) => `\u{1F4C1} ${path.basename(cwd)} \u{2014} \`${cwd}\``);
    await sendMessage(dm.id, `\u{1F7E2} Crispy online.\n\n**Active folders:**\n${lines.join('\n')}`);
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: 'failed to send startup DM', data: err });
  }
}

// ---------------------------------------------------------------------------
// Thread Create — user-created forum posts become sessions
// ---------------------------------------------------------------------------

function handleThreadCreate(event: { id: string; parent_id: string; name: string; guild_id: string }): void {
  if (!commandsEnabled) return;

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

  // Bot-self messages: handle probe protocol, drop everything else
  if (message.author.id === botId) {
    if (commandsEnabled && message.content.trim() === '!crispy') {
      void handleCommand(channelId, '!crispy', buildCommandContext());
      return;
    }
    if (probeResolve && message.content.startsWith('crispy-pong')) {
      const resolve = probeResolve;
      probeResolve = null;
      resolve(message.content);
    }
    return;
  }

  if (!commandsEnabled) return;

  // Route 1: message in a session post -> track + follow-up turn + update activity
  if (getSessionForChannel(channelId)) {
    // Track non-bot message for anchor detection (deduplication)
    trackUserMessage(channelId, message.id, message.content);
    // Update activity for archival tracking
    lastActivityMap.set(channelId, Date.now());
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
