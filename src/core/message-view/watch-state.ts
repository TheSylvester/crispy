/**
 * Watch State — session watch registry, sync loop, and approval interactions
 *
 * Owns the WatchState type (including ThreadSlot-based sync model), the
 * session→Discord channel maps, and all functions that operate on watched
 * sessions. Index.ts passes lifecycle values (forumChannelId, guildId) as
 * parameters to avoid circular imports.
 *
 * Thread sync uses a heterogeneous slot model: bot-rendered content segments
 * interleave with user-authored Discord messages (anchors). The renderer
 * produces RenderSegment[], and syncSession() walks segments against
 * ThreadSlot[] to edit, create, skip, or clear messages.
 *
 * @module message-view/watch-state
 */

import { log } from '../log.js';
import { subscribeSession, sendTurn } from '../session-manager.js';
import { unsubscribe, resolveApproval } from '../session-channel.js';
import type { Subscriber, SubscriberMessage, SessionChannel } from '../session-channel.js';
import type { Vendor } from '../transcript.js';
import type { ApprovalOption, PendingApprovalInfo } from '../channel-events.js';
import type { TurnIntent, TurnSettings } from '../agent-adapter.js';
import {
  applySubscriberMessage,
  createSessionSnapshot,
  type SessionSnapshot,
} from '../session-snapshot.js';
import {
  sendMessage,
  editMessage,
  createForumPost,
  archiveThread,
  discordFetch,
  triggerTyping,
  getMessages,
  getBotUserId,
  sendMessageWithComponents,
} from './discord-transport.js';
import type { MessageComponent } from './discord-transport.js';
import { DiscordApiError } from './discord-transport.js';
import {
  renderSessionWithAnchors,
  getStatusLine,
  truncate,
  DISCORD_MAX_LENGTH,
} from './render.js';
import type { RenderSegment } from './render.js';

const SOURCE = 'message-view';
const MIN_PROMPT_LENGTH = 3;

function buildPermissionSettings(mode: string | null): Partial<TurnSettings> {
  if (!mode) return {};
  return {
    permissionMode: mode as TurnSettings['permissionMode'],
    ...(mode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingInteraction {
  discordMessageId: string;
  toolUseId: string;
  toolName: string;
  options: ApprovalOption[];
}

export interface ThreadSlot {
  kind: 'bot' | 'user';
  discordMessageId: string;
  content?: string;        // last-synced content (bot slots)
  entryIndex?: number;     // transcript entry index (user slots)
}

interface WatchState {
  sessionId: string;
  discordChannelId: string;
  subscriber: Subscriber;
  /** Null until subscribeSession completes (pre-registered for catchup delivery). */
  channel: SessionChannel | null;
  snapshot: SessionSnapshot;
  /** Ordered sequence of bot and user message slots in the Discord thread. */
  threadSlots: ThreadSlot[];
  /** Non-bot Discord messages in the thread: discordMessageId → content text. */
  userMessages: Map<string, string>;
  dirty: boolean;
  pendingInteractions: Map<string, PendingInteraction>;
  /** True while syncSession is in-flight (prevents concurrent syncs). */
  syncing: boolean;
  consecutiveFailures: number;
  permissionMode: string | null;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const watchedSessions = new Map<string, WatchState>();
const channelToSession = new Map<string, string>();
const commandSessionIds = new Set<string>();
const pendingWatches = new Set<string>();

// ---------------------------------------------------------------------------
// Accessors (no raw map exports)
// ---------------------------------------------------------------------------

export function hasWatch(sessionId: string): boolean {
  return watchedSessions.has(sessionId);
}

export function getWatch(sessionId: string): WatchState | undefined {
  return watchedSessions.get(sessionId);
}

export function getSessionForChannel(channelId: string): string | undefined {
  return channelToSession.get(channelId);
}

export function isCommandSession(sessionId: string): boolean {
  return commandSessionIds.has(sessionId);
}

export function addCommandSession(sessionId: string): void {
  commandSessionIds.add(sessionId);
}

export function clearCommandSessions(): void {
  commandSessionIds.clear();
}

export function watchCount(): number {
  return watchedSessions.size;
}

export function allWatches(): IterableIterator<WatchState> {
  return watchedSessions.values();
}

export function disposeWatch(sessionId: string): void {
  const state = watchedSessions.get(sessionId);
  if (!state) return;

  if (state.channel) {
    try { unsubscribe(state.channel, state.subscriber); } catch { /* best-effort */ }
  }
  channelToSession.delete(state.discordChannelId);
  watchedSessions.delete(sessionId);
  commandSessionIds.delete(sessionId);
  archiveThread(state.discordChannelId).catch(() => {});

  log({ source: SOURCE, level: 'info', summary: `disposed watch for ${sessionId.slice(0, 8)}` });
}

export function disposeAllWatches(): void {
  for (const sessionId of watchedSessions.keys()) {
    disposeWatch(sessionId);
  }
}

export function rekeyWatchState(oldId: string, newId: string): void {
  const state = watchedSessions.get(oldId);
  if (!state) return;
  state.sessionId = newId;
  watchedSessions.delete(oldId);
  watchedSessions.set(newId, state);
  channelToSession.set(state.discordChannelId, newId);
  commandSessionIds.add(newId);
}

// ---------------------------------------------------------------------------
// Watch State Registration
// ---------------------------------------------------------------------------

function registerWatchState(
  sessionId: string,
  discordChannelId: string,
  subscriber: Subscriber,
  permissionMode?: string | null,
  starterMessageId?: string,
): WatchState {
  const threadSlots: ThreadSlot[] = [];
  if (starterMessageId) {
    threadSlots.push({ kind: 'bot', discordMessageId: starterMessageId, content: '' });
  }
  const state: WatchState = {
    sessionId,
    discordChannelId,
    subscriber,
    channel: null,
    snapshot: createSessionSnapshot(),
    threadSlots,
    userMessages: new Map(),
    dirty: false,
    pendingInteractions: new Map(),
    syncing: false,
    consecutiveFailures: 0,
    permissionMode: permissionMode ?? null,
  };
  watchedSessions.set(sessionId, state);
  channelToSession.set(discordChannelId, sessionId);
  return state;
}

// ---------------------------------------------------------------------------
// Watch Orchestration
// ---------------------------------------------------------------------------

export async function createWatchedSession(
  vendor: Vendor,
  promptText: string,
  forumChannelId: string,
  guildId: string,
  permissionMode: string | null,
  cwd?: string,
): Promise<{ sessionId: string; discordChannelId: string }> {
  const displayName = promptText.slice(0, 100).replace(/\n/g, ' ').trim() || 'new session';
  const post = await createForumPost(forumChannelId, displayName, '\u{23F3} Starting session\u{2026}', {
    autoArchiveDuration: 1440,
  });

  const discordChannelId = post.id;
  const starterMessageId = post.messageId;
  const sessionCwd = cwd ?? process.cwd();
  const intent: TurnIntent = {
    target: { kind: 'new', vendor, cwd: sessionCwd },
    content: [{ type: 'text', text: promptText }],
    clientMessageId: crypto.randomUUID(),
    settings: buildPermissionSettings(permissionMode),
  };

  const tempSessionId = `prompt-${Date.now()}`;
  commandSessionIds.add(tempSessionId);
  const subscriber = buildWatchSubscriber(tempSessionId);

  // Register watch state EAGERLY under pending ID — the subscriber's
  // session_changed handler will rekey to real ID synchronously before
  // list-notify can trigger auto-watch.
  registerWatchState(tempSessionId, discordChannelId, subscriber, permissionMode, starterMessageId);

  let realId: string;
  try {
    const result = await sendTurn(intent, subscriber);
    commandSessionIds.add(result.sessionId);

    // rekeyPromise resolves AFTER our subscriber has already rekeyed the
    // watch maps (subscriber fires before rekey subscriber in broadcast order)
    realId = result.rekeyPromise ? await result.rekeyPromise : result.sessionId;
    commandSessionIds.add(realId);
  } catch (err) {
    // Clean up eagerly registered state + Discord thread on failure
    watchedSessions.delete(tempSessionId);
    channelToSession.delete(discordChannelId);
    commandSessionIds.delete(tempSessionId);
    archiveThread(discordChannelId).catch(() => {});
    throw err;
  }

  // Rename post to canonical session-{prefix} format
  const canonicalName = `session-${realId.slice(0, 8)}`;
  discordFetch('PATCH', `/channels/${discordChannelId}`, { name: canonicalName }).catch((err) => {
    log({ source: SOURCE, level: 'warn', summary: `failed to rename post to ${canonicalName}`, data: err });
  });

  // Update starter message with session ID anchor (for crash recovery)
  if (starterMessageId) {
    editMessage(discordChannelId, starterMessageId, `\u{1F4CB} Session \`${realId}\``).catch((err) => {
      log({ source: SOURCE, level: 'warn', summary: `failed to update starter message with session ID anchor`, data: err });
    });
  }

  // Get the (possibly rekeyed) watch state and subscribe
  const state = watchedSessions.get(realId);
  if (state) {
    state.channel = await subscribeSession(realId, subscriber);
  }

  log({ source: SOURCE, level: 'info', summary: `created session ${realId.slice(0, 12)}` });
  return { sessionId: realId, discordChannelId };
}

export async function watchSession(
  sessionId: string,
  forumChannelId: string,
  opts: { auto: boolean; displayName?: string },
  permissionMode?: string | null,
): Promise<void> {
  if (watchedSessions.has(sessionId) || pendingWatches.has(sessionId)) return;
  pendingWatches.add(sessionId);
  try {
    const postName = opts.displayName?.slice(0, 100) || `session-${sessionId.slice(0, 8)}`;
    const anchorText = `\u{1F4CB} Session \`${sessionId}\``;
    const post = await createForumPost(forumChannelId, postName, anchorText, {
      autoArchiveDuration: 1440,
    });
    const discordChannelId = post.id;
    const starterMessageId = post.messageId;

    const subscriber = buildWatchSubscriber(sessionId);
    const state = registerWatchState(sessionId, discordChannelId, subscriber, permissionMode, starterMessageId);

    // Catchup: populate userMessages with existing non-bot messages
    await populateUserMessages(state).catch((err) => {
      log({ source: SOURCE, level: 'warn', summary: `catchup user messages failed for ${sessionId.slice(0, 8)}`, data: err });
    });

    try {
      state.channel = await subscribeSession(sessionId, subscriber);
    } catch (err) {
      disposeWatch(sessionId);
      throw err;
    }

    log({ source: SOURCE, level: 'info', summary: `${opts.auto ? 'auto-' : ''}watching session ${sessionId.slice(0, 12)}\u{2026}` });
  } finally {
    pendingWatches.delete(sessionId);
  }
}

/**
 * Watch a session using an existing Discord thread (no forum post creation).
 * Used for user-created forum posts where the thread already exists.
 */
export async function watchSessionInThread(
  sessionId: string,
  discordChannelId: string,
  permissionMode?: string | null,
): Promise<void> {
  if (watchedSessions.has(sessionId) || pendingWatches.has(sessionId)) return;
  pendingWatches.add(sessionId);
  try {
    const subscriber = buildWatchSubscriber(sessionId);
    const state = registerWatchState(sessionId, discordChannelId, subscriber, permissionMode);

    // Catchup: populate userMessages with existing non-bot messages
    await populateUserMessages(state).catch((err) => {
      log({ source: SOURCE, level: 'warn', summary: `catchup user messages failed for ${sessionId.slice(0, 8)}`, data: err });
    });

    try {
      state.channel = await subscribeSession(sessionId, subscriber);
    } catch (err) {
      disposeWatch(sessionId);
      throw err;
    }

    log({ source: SOURCE, level: 'info', summary: `watching session ${sessionId.slice(0, 12)} in existing thread ${discordChannelId}\u{2026}` });
  } finally {
    pendingWatches.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Follow-up Turns (user message in forum post)
// ---------------------------------------------------------------------------

export async function handlePostMessage(
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
    settings: buildPermissionSettings(state.permissionMode),
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

function buildWatchSubscriber(initialSessionId: string): Subscriber {
  let sessionId = initialSessionId;
  return {
    id: `message-view-watch-${initialSessionId.slice(0, 12)}`,
    send(event: SubscriberMessage): void {
      try {
        // Detect session_changed and rekey SYNCHRONOUSLY — this subscriber
        // fires BEFORE list-notify, so rekey completes before auto-watch
        // can see the session_list_upsert with the real ID.
        if (event.type === 'event' && event.event.type === 'notification' &&
            event.event.kind === 'session_changed' && 'sessionId' in event.event) {
          const realId = (event.event as { sessionId: string }).sessionId;
          rekeyWatchState(sessionId, realId);
          sessionId = realId;
        }

        let state = watchedSessions.get(sessionId);
        if (!state) {
          // Fallback: linear scan by subscriber identity. Should be unreachable
          // after synchronous rekey above — log if it fires to detect bugs.
          for (const s of watchedSessions.values()) {
            if (s.subscriber === this) { state = s; break; }
          }
          if (state) {
            log({ source: SOURCE, level: 'warn', summary: `subscriber fallback scan hit for ${sessionId.slice(0, 12)} — rekey may have failed` });
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
  const prevSnapshot = state.snapshot;
  const prevApprovals = prevSnapshot.pendingApprovals;
  state.snapshot = applySubscriberMessage(prevSnapshot, event);

  reconcileApprovals(state, prevApprovals, state.snapshot.pendingApprovals);
  if (state.snapshot !== prevSnapshot) state.dirty = true;

  if (event.type === 'catchup') {
    void syncSession(state).catch((err) => {
      log({ source: SOURCE, level: 'error', summary: 'catchup flush failed', data: err });
    });
  }
}

// ---------------------------------------------------------------------------
// Approval Interactions
// ---------------------------------------------------------------------------

function buildApprovalButtons(approval: PendingApprovalInfo): MessageComponent[] {
  const buttons: MessageComponent[] = [];
  for (const opt of approval.options) {
    const customId = `approve:${approval.toolUseId}:${opt.id}`;
    // Discord custom_id limit is 100 chars — skip options that would exceed it
    if (customId.length > 100) continue;

    const id = opt.id.toLowerCase();
    let style = 2; // Secondary
    if (id.includes('deny')) style = 4;                          // Danger (red)
    else if (id === 'allow' || id === 'always_allow') style = 3; // Success (green)
    // allow_session and other allow variants stay Secondary (gray)

    buttons.push({
      type: 2, // Button
      style,
      label: opt.label,
      custom_id: customId,
    });
  }

  // Discord limits ActionRows to 5 buttons each
  const rows: MessageComponent[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }
  return rows;
}

function buildApprovalMessage(approval: PendingApprovalInfo): string {
  const inputStr = typeof approval.input === 'string'
    ? approval.input.slice(0, 300)
    : JSON.stringify(approval.input).slice(0, 300);
  const reason = approval.reason ? `> ${approval.reason}\n\n` : '';
  return truncate(
    `\u{26A0}\u{FE0F} **Approval Required: ${approval.toolName}**\n\`${inputStr}\`\n${reason}`,
    DISCORD_MAX_LENGTH,
  );
}

function reconcileApprovals(
  state: WatchState,
  previous: PendingApprovalInfo[],
  next: PendingApprovalInfo[],
): void {
  if (previous.length === 0 && next.length === 0) return;

  const previousIds = new Set(previous.map((approval) => approval.toolUseId));
  const nextIds = new Set(next.map((approval) => approval.toolUseId));

  for (const toolUseId of state.pendingInteractions.keys()) {
    if (!nextIds.has(toolUseId)) {
      state.pendingInteractions.delete(toolUseId);
    }
  }

  for (const approval of next) {
    if (state.pendingInteractions.has(approval.toolUseId)) continue;

    void postApprovalInteraction(state, approval).catch((err) => {
      log({
        source: SOURCE,
        level: 'error',
        summary: previousIds.has(approval.toolUseId)
          ? 'failed to restore approval interaction'
          : 'failed to post approval',
        data: err,
      });
    });
  }
}

async function postApprovalInteraction(state: WatchState, approval: PendingApprovalInfo): Promise<void> {
  if (state.pendingInteractions.has(approval.toolUseId)) return;

  const buttons = buildApprovalButtons(approval);
  const text = buildApprovalMessage(approval);
  const msg = await sendMessageWithComponents(state.discordChannelId, text, buttons);

  state.pendingInteractions.set(approval.toolUseId, {
    discordMessageId: msg.id,
    toolUseId: approval.toolUseId,
    toolName: approval.toolName,
    options: approval.options,
  });

  log({ source: SOURCE, level: 'info', summary: `posted approval for ${approval.toolName} (${approval.toolUseId.slice(0, 8)})` });
}

export function resolveButtonApproval(
  channelId: string,
  toolUseId: string,
  optionId: string,
): { emoji: string; toolName: string; label: string } | null {
  const sessionId = channelToSession.get(channelId);
  if (!sessionId) return null;
  const state = watchedSessions.get(sessionId);
  if (!state) return null;

  const interaction = state.pendingInteractions.get(toolUseId);
  if (!interaction) return null;
  if (!state.channel) return null;

  resolveApproval(state.channel, toolUseId, optionId);
  state.pendingInteractions.delete(toolUseId);

  const opt = interaction.options.find(o => o.id === optionId);
  const id = optionId.toLowerCase();
  const emoji = id.includes('deny') ? '\u{274C}' : id.includes('allow') ? '\u{2705}' : '\u{1F518}';

  log({ source: SOURCE, level: 'info', summary: `approval resolved: ${interaction.toolName} \u{2192} ${optionId}` });
  return { emoji, toolName: interaction.toolName, label: opt?.label ?? optionId };
}

// ---------------------------------------------------------------------------
// User Message Catchup
// ---------------------------------------------------------------------------

/**
 * Populate userMessages by fetching existing non-bot messages from the thread.
 * Uses `?after=0&limit=100` for chronological ordering, paginates if needed.
 */
async function populateUserMessages(state: WatchState): Promise<void> {
  const botId = getBotUserId();
  let before: string | undefined;
  let hasMore = true;
  const MAX_PAGES = 5; // Cap at 500 messages
  let pages = 0;

  while (hasMore && pages < MAX_PAGES) {
    pages++;
    const msgs = await getMessages(state.discordChannelId, { before, limit: 100 });
    if (msgs.length === 0) break;

    for (const msg of msgs) {
      if (!msg.author.bot && msg.author.id !== botId) {
        state.userMessages.set(msg.id, msg.content);
      }
    }

    if (msgs.length < 100) {
      hasMore = false;
    } else {
      before = msgs[msgs.length - 1].id;
    }
  }

  if (pages >= MAX_PAGES) {
    log({ source: SOURCE, level: 'warn', summary: `catchup capped at ${MAX_PAGES} pages for ${state.sessionId.slice(0, 8)}` });
  }
  if (state.userMessages.size > 0) {
    log({ source: SOURCE, level: 'info', summary: `catchup: ${state.userMessages.size} user messages in ${state.sessionId.slice(0, 8)}` });
  }
}

/**
 * Store a non-bot message from a watched thread. Called by the provider's
 * Gateway handler on MESSAGE_CREATE for non-bot authors.
 */
export function trackUserMessage(channelId: string, messageId: string, content: string): void {
  const sessionId = channelToSession.get(channelId);
  if (!sessionId) return;
  const state = watchedSessions.get(sessionId);
  if (!state) return;
  state.userMessages.set(messageId, content);
}

// ---------------------------------------------------------------------------
// Render -> Diff -> Sync (segment-based)
// ---------------------------------------------------------------------------

/**
 * Handle a Discord API error during sync. Returns true if the caller should
 * abort the sync loop (circuit breaker or retry-later).
 */
async function handleSyncError(state: WatchState, err: unknown, context: string): Promise<boolean> {
  log({ source: SOURCE, level: 'error', summary: `${context} failed`, data: err });

  if (err instanceof DiscordApiError && err.code === 50083) {
    try {
      await discordFetch('PATCH', `/channels/${state.discordChannelId}`, { archived: false });
      log({ source: SOURCE, level: 'warn', summary: `unarchived thread ${state.discordChannelId} — retrying` });
      state.dirty = true;
      return true;
    } catch (unarchiveErr) {
      log({ source: SOURCE, level: 'error', summary: `unarchive failed for ${state.discordChannelId}`, data: unarchiveErr });
    }
  }

  state.consecutiveFailures++;
  if ((err instanceof DiscordApiError && err.permanent) || state.consecutiveFailures >= 5) {
    log({ source: SOURCE, level: 'error', summary: `circuit breaker: ${state.sessionId.slice(0, 8)} — disposing watch after ${state.consecutiveFailures} failures` });
    disposeWatch(state.sessionId);
    return true;
  }

  state.dirty = true;
  return true;
}

export async function syncSession(state: WatchState): Promise<void> {
  if (state.syncing) {
    log({ source: SOURCE, level: 'debug', summary: `sync skip: ${state.sessionId.slice(0, 8)} already syncing` });
    return;
  }
  state.syncing = true;
  state.dirty = false;

  try {
    const segments = renderSessionWithAnchors(
      state.snapshot.entries,
      state.snapshot.toolResults,
      state.userMessages,
      getStatusLine(state.snapshot.status),
    );

    const contentSegments = segments.filter((s): s is Extract<RenderSegment, { kind: 'content' }> => s.kind === 'content');
    log({ source: SOURCE, level: 'info', summary: `sync ${state.sessionId.slice(0, 8)}: ${segments.length} segments (${contentSegments.length} content) from ${state.snapshot.entries.length} entries (slots=${state.threadSlots.length}, status=${state.snapshot.status})` });

    let slotIndex = 0;

    for (const segment of segments) {
      if (segment.kind === 'discord-anchor') {
        // Skip past bot slots until we find the user slot — clear any with stale content
        while (slotIndex < state.threadSlots.length && state.threadSlots[slotIndex].kind === 'bot') {
          const skipSlot = state.threadSlots[slotIndex];
          if (skipSlot.content) {
            await editMessage(state.discordChannelId, skipSlot.discordMessageId, '\u{200B}').catch(() => {});
            skipSlot.content = '';
          }
          slotIndex++;
        }
        if (slotIndex < state.threadSlots.length && state.threadSlots[slotIndex].kind === 'user') {
          slotIndex++; // Skip over existing user message slot
        } else {
          // User message exists in Discord but not tracked — add slot
          state.threadSlots.splice(slotIndex, 0, {
            kind: 'user',
            discordMessageId: segment.messageId,
            entryIndex: segment.entryIndex,
          });
          slotIndex++;
        }
        continue;
      }

      // Content segment — edit existing bot message or post new one
      if (slotIndex < state.threadSlots.length && state.threadSlots[slotIndex].kind === 'bot') {
        const slot = state.threadSlots[slotIndex];
        if (slot.content !== segment.text) {
          try {
            await editMessage(state.discordChannelId, slot.discordMessageId, segment.text);
            slot.content = segment.text;
          } catch (err) {
            if (await handleSyncError(state, err, `edit slot ${slotIndex}`)) return;
          }
        }
      } else if (slotIndex < state.threadSlots.length && state.threadSlots[slotIndex].kind === 'user') {
        // Need a bot slot but found a user slot — insert before it
        try {
          const msg = await sendMessage(state.discordChannelId, segment.text);
          state.threadSlots.splice(slotIndex, 0, {
            kind: 'bot',
            discordMessageId: msg.id,
            content: segment.text,
          });
        } catch (err) {
          if (await handleSyncError(state, err, `send before user slot ${slotIndex}`)) return;
        }
      } else {
        // Past end of slots — create new bot message
        try {
          const msg = await sendMessage(state.discordChannelId, segment.text);
          state.threadSlots.push({
            kind: 'bot',
            discordMessageId: msg.id,
            content: segment.text,
          });
        } catch (err) {
          if (await handleSyncError(state, err, `send new slot ${slotIndex}`)) return;
        }
      }
      slotIndex++;
    }

    // Clear surplus bot slots with zero-width space
    while (slotIndex < state.threadSlots.length) {
      const slot = state.threadSlots[slotIndex];
      if (slot.kind === 'bot' && slot.content) {
        await editMessage(state.discordChannelId, slot.discordMessageId, '\u{200B}').catch(() => {});
        slot.content = '';
      }
      slotIndex++;
    }

    state.consecutiveFailures = 0;
    log({ source: SOURCE, level: 'info', summary: `sync ${state.sessionId.slice(0, 8)}: complete (${segments.length} segments, ${state.threadSlots.length} slots, dirty=${state.dirty})` });
  } finally {
    state.syncing = false;
  }
}
