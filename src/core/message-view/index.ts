/**
 * Message View — Init/shutdown, command polling, and session projection
 *
 * Spike 3: Text buffer + projection sync.
 * Session events render into a MessageBuffer (instant, no API calls).
 * A heartbeat syncs dirty sections to Discord via the projection layer
 * (at most 1 section per session per tick). Catchup replays hundreds of
 * entries instantly to the buffer — the heartbeat drains naturally at ~1 msg/3s.
 *
 * @module message-view/index
 */

import { readFileSync } from 'node:fs';
import { log } from '../log.js';
import { onSettingsChanged } from '../settings/index.js';
import { settingsPath } from '../paths.js';
import { listAllSessions, resolveSessionPrefix, subscribeSession } from '../session-manager.js';
import { subscribeSessionList, unsubscribeSessionList } from '../session-list-manager.js';
import type { SessionListSubscriber } from '../session-list-manager.js';
import type { SessionListEvent } from '../session-list-events.js';
import { getActiveChannels, unsubscribe, resolveApproval } from '../session-channel.js';
import type { Subscriber, SubscriberMessage, SessionChannel } from '../session-channel.js';
import type { TranscriptEntry, ContentBlock } from '../transcript.js';
import type { ApprovalOption, PendingApprovalInfo } from '../channel-events.js';
import {
  initTransport,
  shutdownTransport,
  sendMessage,
  getMessages,
  createThread,
  archiveThread,
  addReaction,
  getReactions,
  editMessage,
} from './discord-transport.js';
import type { DiscordProviderConfig, MessageProviderConfig } from './config.js';
import { createBuffer, getOrCreateSection, getLastSection, appendSection, updateSection, clearBuffer } from './buffer.js';
import type { MessageBuffer } from './buffer.js';
import { createProjection, syncOneDirtySection, clearProjection } from './projection.js';
import type { ProjectionState } from './projection.js';

const SOURCE = 'message-view';
const DISCORD_MAX_LENGTH = 2000;
const SECTION_SOFT_LIMIT = 1800; // leave headroom for Discord's 2000 limit

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let activeConfig: DiscordProviderConfig | null = null;
let commandChannelLastMessageId: string | null = null;
let unsubSettings: (() => void) | null = null;
let unsubSessionList: (() => void) | null = null;
let startTime: number = 0;

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

interface WatchState {
  sessionId: string;
  discordChannelId: string;
  subscriber: Subscriber;
  channel: SessionChannel;
  buffer: MessageBuffer;
  projection: ProjectionState;
  turnCounter: number;
  pendingInteractions: Map<string, PendingInteraction>;
}

/** Maps sessionId → watch state for active projections. */
const watchedSessions = new Map<string, WatchState>();

/** Reverse map: discordChannelId → sessionId (for cleanup lookups). */
const channelToSession = new Map<string, string>();

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
    // Config changed — restart
    if (activeConfig && (next.token !== activeConfig.token || next.commandChannelId !== activeConfig.commandChannelId)) {
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
  // Read messageProviders directly from settings.json.
  // getSettingsSnapshotInternal() constructs a new object from known fields,
  // which strips messageProviders since it's not in the typed schema yet.
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
  initTransport(config.token);

  log({ source: SOURCE, level: 'info', summary: `message view online — polling #${config.commandChannelId}` });

  // Send startup message (fire-and-forget)
  sendMessage(config.commandChannelId, '\u{1F7E2} Crispy Message View online').catch((err) => {
    log({ source: SOURCE, level: 'error', summary: 'failed to send startup message', data: err });
  });

  // Auto-watch: subscribe to session list events so new sessions are watched automatically
  if (config.sessions === 'all') {
    const sessionListSub: SessionListSubscriber = {
      id: 'message-view-session-list',
      send(event: SessionListEvent) {
        if (event.type === 'session_list_upsert') {
          const session = event.session;
          if (session.sessionKind === 'system') return;
          if (watchedSessions.has(session.sessionId)) return;
          // Skip stale sessions on startup — only auto-watch sessions modified in last 10 minutes
          const ageMs = Date.now() - session.modifiedAt.getTime();
          if (ageMs > 10 * 60 * 1000) return;
          void watchSession(session.sessionId, true).catch(err => {
            log({ source: SOURCE, level: 'error', summary: `auto-watch failed for ${session.sessionId.slice(0, 8)}`, data: err });
          });
        }
      },
    };
    subscribeSessionList(sessionListSub);
    unsubSessionList = () => unsubscribeSessionList(sessionListSub);
    log({ source: SOURCE, level: 'info', summary: 'auto-watch enabled — subscribing to session list' });
  }

  heartbeatTimer = setInterval(() => {
    pollCommands().catch((err) => {
      log({ source: SOURCE, level: 'error', summary: 'poll error', data: err });
    });
    // Sync one dirty section per watched session per tick
    for (const state of watchedSessions.values()) {
      syncOneDirtySection(state.projection, state.buffer).catch((err) => {
        log({ source: SOURCE, level: 'error', summary: `projection sync error for ${state.sessionId.slice(0, 8)}`, data: err });
      });
    }
    // Poll pending interactions for user reactions (one per tick across all sessions)
    pollOneInteraction().catch((err) => {
      log({ source: SOURCE, level: 'error', summary: 'interaction poll error', data: err });
    });
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

  // Clean up all active watches
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

  if (activeConfig) {
    // Send shutdown message (best-effort)
    sendMessage(activeConfig.commandChannelId, '\u{1F534} Crispy Message View offline').catch(() => {});
  }
  activeConfig = null;
  commandChannelLastMessageId = null;
  shutdownTransport();
}

async function pollCommands(): Promise<void> {
  if (!activeConfig) return;

  const opts: { after?: string; limit?: number } = { limit: 50 };
  if (commandChannelLastMessageId) opts.after = commandChannelLastMessageId;

  const messages = await getMessages(activeConfig.commandChannelId, opts);
  if (!messages.length) return;

  // Discord returns newest first — reverse to process chronologically
  const sorted = [...messages].reverse();

  // Update the high-water mark to the newest message ID
  commandChannelLastMessageId = sorted[sorted.length - 1].id;

  for (const msg of sorted) {
    // Skip our own messages (check author ID, not bot flag — webhooks have bot=true too)
    if (msg.author.id === '1483229916869693500') continue;
    // Only process ! commands
    if (!msg.content.startsWith('!')) continue;

    const [command, ...args] = msg.content.slice(1).trim().split(/\s+/);
    try {
      await handleCommand(command.toLowerCase(), args);
    } catch (err) {
      log({ source: SOURCE, level: 'error', summary: `command !${command} failed`, data: err });
    }
  }
}

async function handleCommand(command: string, args: string[]): Promise<void> {
  if (!activeConfig) return;
  const channelId = activeConfig.commandChannelId;

  switch (command) {
    case 'status': {
      const uptimeMs = Date.now() - startTime;
      const uptimeMin = Math.floor(uptimeMs / 60000);
      const activeCount = getActiveChannels().length;
      const watchCount = watchedSessions.size;
      await sendMessage(channelId, `Crispy is alive. Uptime: ${uptimeMin}m. Sessions: ${activeCount} active. Watching: ${watchCount}.`);
      break;
    }

    case 'sessions': {
      const allSessions = listAllSessions();
      const recent = allSessions
        .filter((s) => s.sessionKind !== 'system')
        .slice(0, 10);

      if (recent.length === 0) {
        await sendMessage(channelId, 'No sessions found.');
        break;
      }

      const lines: string[] = [];
      let totalLen = 30; // header length estimate
      for (const s of recent) {
        const prefix = s.sessionId.slice(0, 8);
        const title = (s.title ?? s.label ?? '(untitled)').slice(0, 60);
        const ago = formatRelativeTime(s.modifiedAt);
        const watching = watchedSessions.has(s.sessionId) ? ' \u{1F441}' : '';
        const line = `\`${prefix}\` **${s.vendor}** — ${title} (${ago})${watching}`;
        if (totalLen + line.length + 1 > 1900) break; // leave headroom
        lines.push(line);
        totalLen += line.length + 1;
      }
      await sendMessage(channelId, `**Recent sessions (${lines.length}):**\n${lines.join('\n')}`);
      break;
    }

    case 'watch': {
      await handleWatch(args);
      break;
    }

    case 'unwatch': {
      await handleUnwatch(args);
      break;
    }

    default:
      await sendMessage(channelId, `Unknown command \`!${command}\`. Available: \`!status\`, \`!sessions\`, \`!watch <id>\`, \`!unwatch <id>\``);
  }
}

// ---------------------------------------------------------------------------
// Watch / Unwatch
// ---------------------------------------------------------------------------

async function handleWatch(args: string[]): Promise<void> {
  if (!activeConfig) return;
  const channelId = activeConfig.commandChannelId;

  if (args.length === 0) {
    await sendMessage(channelId, 'Usage: `!watch <session-id-prefix>`');
    return;
  }

  const prefix = args[0];

  // Resolve the session ID prefix
  let resolvedId: string;
  try {
    resolvedId = resolveSessionPrefix(prefix);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(channelId, `Failed to resolve session: ${msg}`);
    return;
  }

  // Check if already watching
  if (watchedSessions.has(resolvedId)) {
    const state = watchedSessions.get(resolvedId)!;
    await sendMessage(channelId, `Already watching session \`${resolvedId.slice(0, 8)}\` in <#${state.discordChannelId}>`);
    return;
  }

  await watchSession(resolvedId, false);
}

/**
 * Core watch logic — creates a Discord thread, subscribes to the session,
 * and sets up buffer/projection. Used by both !watch and auto-watch.
 */
async function watchSession(sessionId: string, auto: boolean): Promise<void> {
  if (!activeConfig) return;
  const channelId = activeConfig.commandChannelId;

  // Double-check (race between auto-watch events)
  if (watchedSessions.has(sessionId)) return;

  // Create a thread in the command channel for the session feed.
  // Post an anchor message first, then create a thread on it.
  const threadName = `session-${sessionId.slice(0, 8)}`;
  const anchorText = auto
    ? `\u{1F4E1} Auto-watching session \`${sessionId.slice(0, 8)}\``
    : `\u{1F4E1} Watching session \`${sessionId.slice(0, 8)}\`\u{2026}`;
  let discordChannel: { id: string; name: string };
  try {
    const anchor = await sendMessage(channelId, anchorText);
    discordChannel = await createThread(channelId, anchor.id, threadName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!auto) await sendMessage(channelId, `Failed to create thread: ${msg}`);
    throw err;
  }

  // Build buffer and projection for this session
  const discordChannelId = discordChannel.id;
  const buffer = createBuffer();
  const projection = createProjection(discordChannelId);

  // Create the status section as the first section
  appendSection(buffer, 'status', '\u{23F3} Connecting\u{2026}');

  // Build the subscriber that renders session events into the buffer
  const subscriber = buildWatchSubscriber(sessionId, buffer);

  // Subscribe to the session — this creates a channel if needed, loads
  // history, and immediately sends a catchup message to our subscriber.
  let sessionChannel: SessionChannel;
  try {
    sessionChannel = await subscribeSession(sessionId, subscriber);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Archive the thread we just created
    archiveThread(discordChannelId).catch(() => {});
    if (!auto) await sendMessage(channelId, `Failed to subscribe to session: ${msg}`);
    throw err;
  }

  // Store watch state
  const state: WatchState = {
    sessionId,
    discordChannelId,
    subscriber,
    channel: sessionChannel,
    buffer,
    projection,
    turnCounter: 0,
    pendingInteractions: new Map(),
  };
  watchedSessions.set(sessionId, state);
  channelToSession.set(discordChannelId, sessionId);

  log({ source: SOURCE, level: 'info', summary: `${auto ? 'auto-' : ''}watching session ${sessionId.slice(0, 12)}\u{2026} in thread ${threadName}` });
}

async function handleUnwatch(args: string[]): Promise<void> {
  if (!activeConfig) return;
  const channelId = activeConfig.commandChannelId;

  if (args.length === 0) {
    await sendMessage(channelId, 'Usage: `!unwatch <session-id-prefix>`');
    return;
  }

  const prefix = args[0];

  // Find the watched session matching this prefix
  let matchedId: string | null = null;
  for (const sessionId of watchedSessions.keys()) {
    if (sessionId.startsWith(prefix)) {
      matchedId = sessionId;
      break;
    }
  }

  if (!matchedId) {
    await sendMessage(channelId, `No watched session matching prefix \`${prefix}\``);
    return;
  }

  const state = watchedSessions.get(matchedId)!;

  // Unsubscribe from the session channel
  try {
    unsubscribe(state.channel, state.subscriber);
  } catch { /* best-effort */ }

  // Archive the thread (preserves history, hides from channel list)
  try {
    await archiveThread(state.discordChannelId);
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: `failed to archive thread for unwatch`, data: err });
  }

  // Clean up state
  clearBuffer(state.buffer);
  clearProjection(state.projection);
  channelToSession.delete(state.discordChannelId);
  watchedSessions.delete(matchedId);

  log({ source: SOURCE, level: 'info', summary: `unwatched session ${matchedId.slice(0, 12)}…` });
  await sendMessage(channelId, `Unwatched session \`${matchedId.slice(0, 8)}\``);
}

// ---------------------------------------------------------------------------
// Session Event Subscriber
// ---------------------------------------------------------------------------

/**
 * Build a Subscriber that renders session events into a MessageBuffer.
 *
 * The send() method is synchronous (called by the session channel's broadcast).
 * No Discord API calls happen here — the heartbeat drains dirty sections.
 */
function buildWatchSubscriber(sessionId: string, buffer: MessageBuffer): Subscriber {
  return {
    id: `message-view-watch-${sessionId.slice(0, 12)}`,
    send(event: SubscriberMessage): void {
      try {
        // Look up WatchState to get the turn counter
        const state = watchedSessions.get(sessionId);
        handleWatchEvent(buffer, event, state);
      } catch (err) {
        log({ source: SOURCE, level: 'error', summary: `watch subscriber error for ${sessionId.slice(0, 12)}…`, data: err });
      }
    },
  };
}

/**
 * Route a session event into the buffer. No Discord API calls —
 * the heartbeat syncs dirty sections via the projection layer.
 */
function handleWatchEvent(buffer: MessageBuffer, event: SubscriberMessage, state: WatchState | undefined): void {
  switch (event.type) {
    case 'catchup': {
      // Render all historical entries into buffer sections
      for (const entry of event.entries) {
        renderEntryToBuffer(buffer, entry, state);
      }
      // Update the status section with current state
      const statusSection = getOrCreateSection(buffer, 'status', '');
      if (event.state === 'streaming' || event.state === 'active') {
        updateSection(statusSection, '\u{23F3} Active');
      } else if (event.state === 'idle') {
        updateSection(statusSection, '\u{2705} Idle');
      } else if (event.state === 'awaiting_approval' && event.pendingApprovals.length > 0) {
        const tools = event.pendingApprovals.map((a) => a.toolName).join(', ');
        updateSection(statusSection, `\u{26A0}\u{FE0F} Awaiting approval: ${tools}`);
        // Post approval interactions for each pending approval (catchup)
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
            updateSection(statusSection, '\u{23F3} Active');
            break;
          case 'idle':
            updateSection(statusSection, '\u{2705} Idle');
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
      // Other event types (notification) — ignore silently
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Approval Interactions
// ---------------------------------------------------------------------------

const BOT_USER_ID = '1483229916869693500';
const NUMBERED_EMOJI = ['1\u{FE0F}\u{20E3}', '2\u{FE0F}\u{20E3}', '3\u{FE0F}\u{20E3}', '4\u{FE0F}\u{20E3}', '5\u{FE0F}\u{20E3}'];

/**
 * Build emoji → optionId mapping from approval options.
 * Known patterns: allow → ✅, allow_session → 🔁, deny → ❌.
 * Unknown patterns fall back to numbered emoji.
 */
function buildEmojiMap(options: ApprovalOption[]): Map<string, string> {
  const map = new Map<string, string>();
  let numberedIdx = 0;

  for (const opt of options) {
    const id = opt.id.toLowerCase();
    if (id.includes('deny')) {
      map.set('\u{274C}', opt.id); // ❌
    } else if (id.includes('allow') && id.includes('session')) {
      map.set('\u{1F501}', opt.id); // 🔁
    } else if (id.includes('allow')) {
      map.set('\u{2705}', opt.id); // ✅
    } else {
      // Fallback to numbered emoji
      const emoji = NUMBERED_EMOJI[numberedIdx] ?? `${numberedIdx + 1}\u{FE0F}\u{20E3}`;
      map.set(emoji, opt.id);
      numberedIdx++;
    }
  }

  return map;
}

/**
 * Build the approval message text for Discord.
 */
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
    const opt = approval.options.find((o) => o.id === optionId);
    optionLabels.push(`${emoji} ${opt?.label ?? optionId}`);
  }

  return truncate(
    `\u{26A0}\u{FE0F} **Approval Required: ${approval.toolName}**\n\`${inputStr}\`\n${reason}${optionLabels.join('  |  ')}`,
    DISCORD_MAX_LENGTH,
  );
}

/**
 * Post an approval interaction to Discord (async, fire-and-forget from subscriber).
 * Sends the message, adds emoji reactions, and stores the PendingInteraction.
 */
async function postApprovalInteraction(
  state: WatchState,
  approval: PendingApprovalInfo,
): Promise<void> {
  // Skip if we already have a pending interaction for this toolUseId
  if (state.pendingInteractions.has(approval.toolUseId)) return;

  const emojiToOptionId = buildEmojiMap(approval.options);
  const text = buildApprovalMessage(approval, emojiToOptionId);

  const msg = await sendMessage(state.discordChannelId, text);

  // Add reactions in sequence (Discord requires sequential reaction adds)
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

/**
 * Poll at most one pending interaction across all watched sessions.
 * Checks reactions for user input and resolves the approval if found.
 */
async function pollOneInteraction(): Promise<void> {
  for (const state of watchedSessions.values()) {
    for (const [toolUseId, interaction] of state.pendingInteractions) {
      // If the approval is no longer pending in the channel, clean up
      if (!state.channel.pendingApprovals.has(toolUseId)) {
        state.pendingInteractions.delete(toolUseId);
        try {
          await editMessage(
            state.discordChannelId,
            interaction.discordMessageId,
            `\u{2705} **${interaction.toolName}** — resolved externally`,
          );
        } catch { /* best-effort */ }
        return; // one per tick
      }

      // Check each emoji for non-bot reactions
      for (const [emoji, optionId] of interaction.emojiToOptionId) {
        try {
          const reactions = await getReactions(state.discordChannelId, interaction.discordMessageId, emoji);
          const userReaction = reactions.find((r) => r.id !== BOT_USER_ID);
          if (userReaction) {
            // Resolve the approval
            resolveApproval(state.channel, toolUseId, optionId);
            state.pendingInteractions.delete(toolUseId);

            const opt = interaction.options.find((o) => o.id === optionId);
            try {
              await editMessage(
                state.discordChannelId,
                interaction.discordMessageId,
                `${emoji} **${interaction.toolName}** — ${opt?.label ?? optionId}`,
              );
            } catch { /* best-effort */ }

            log({
              source: SOURCE,
              level: 'info',
              summary: `approval resolved: ${interaction.toolName} → ${optionId}`,
            });
            return; // one per tick
          }
        } catch (err) {
          // 404 or other error — approval may be gone, clean up
          log({ source: SOURCE, level: 'debug', summary: `reaction poll error for ${emoji}`, data: err });
          state.pendingInteractions.delete(toolUseId);
          return; // one per tick
        }
      }

      return; // only poll one interaction per tick (rate limit awareness)
    }
  }
}

// ---------------------------------------------------------------------------
// Buffer Rendering
// ---------------------------------------------------------------------------

/**
 * Render a transcript entry into the buffer. Appends to the current section
 * or creates a new one at logical boundaries / size limits.
 */
function renderEntryToBuffer(buffer: MessageBuffer, entry: TranscriptEntry, state: WatchState | undefined): void {
  const rendered = renderEntry(entry);
  if (!rendered) return;

  // User messages always start a new section
  if (entry.type === 'user') {
    const turnId = nextTurnId(state);
    appendSection(buffer, turnId, rendered);
    return;
  }

  // Assistant entries: append to current section or create new one
  const last = getLastSection(buffer);

  // Create a new section if:
  // - No existing content section (only status)
  // - Current section is the status section
  // - Adding would exceed soft limit
  if (!last || last.id === 'status' || (last.content.length + rendered.length + 1) > SECTION_SOFT_LIMIT) {
    const turnId = nextTurnId(state);
    appendSection(buffer, turnId, rendered);
    return;
  }

  // Append to existing section
  const newContent = last.content ? `${last.content}\n${rendered}` : rendered;
  updateSection(last, newContent);
}

/** Generate a monotonically increasing turn section ID. */
function nextTurnId(state: WatchState | undefined): string {
  if (state) {
    state.turnCounter++;
    return `turn-${state.turnCounter}`;
  }
  // Fallback for catchup before WatchState is registered
  return `turn-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Entry Rendering
// ---------------------------------------------------------------------------

/**
 * Render a TranscriptEntry as a simple markdown string for Discord.
 * Returns null if the entry has no renderable content.
 */
function renderEntry(entry: TranscriptEntry): string | null {
  const content = entry.message?.content;
  if (!content) return null;

  // Determine role from the entry type
  if (entry.type === 'user') {
    const text = extractText(content);
    if (!text) return null;
    return truncate(`**User:** ${text}`, DISCORD_MAX_LENGTH);
  }

  if (entry.type === 'assistant') {
    return renderAssistantEntry(content);
  }

  // result, system, etc. — skip
  return null;
}

/**
 * Render assistant content blocks. Text blocks get the Assistant prefix;
 * tool_use blocks render as `icon name subject [meta] status`;
 * tool_result blocks are skipped (status updates are a later refinement).
 */
function renderAssistantEntry(content: string | ContentBlock[]): string | null {
  if (typeof content === 'string') {
    if (!content) return null;
    return truncate(`**Assistant:** ${content.slice(0, 500)}`, DISCORD_MAX_LENGTH);
  }

  const parts: string[] = [];

  for (const block of content) {
    switch (block.type) {
      case 'text': {
        if (block.text) {
          parts.push(`**Assistant:** ${block.text.slice(0, 500)}`);
        }
        break;
      }
      case 'tool_use': {
        const input = (block.input ?? {}) as Record<string, unknown>;
        parts.push(renderToolUse(block.name, input));
        break;
      }
      case 'tool_result':
        // Skip — the tool_use line with ⏳ is sufficient for now.
        // Status updates (⏳→✓) require tool pairing, which is a later refinement.
        break;
      // thinking, image — skip
    }
  }

  if (parts.length === 0) return null;
  return truncate(parts.join('\n'), DISCORD_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// Tool Rendering
// ---------------------------------------------------------------------------

/** Shorten a file path to last 2 segments (parent/filename). */
function shortPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : filePath;
}

/** Extract a display subject from tool input using the priority chain. */
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

/**
 * Render a tool_use block as: icon name subject [meta] status
 */
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

/**
 * Extract plain text from content (string or ContentBlock[]).
 */
function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content.slice(0, 500);
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text);
    }
  }
  return texts.join(' ').slice(0, 500);
}

/**
 * Truncate a string to the given max length.
 */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
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
