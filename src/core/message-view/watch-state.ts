/**
 * Watch State — session watch registry, sync loop, and approval interactions
 *
 * Owns the WatchState type, the session→Discord channel maps, and all
 * functions that operate on watched sessions. Index.ts passes lifecycle
 * values (forumChannelId, guildId) as parameters to avoid circular imports.
 *
 * @module message-view/watch-state
 */

import { log } from '../log.js';
import { subscribeSession, sendTurn } from '../session-manager.js';
import { unsubscribe, resolveApproval } from '../session-channel.js';
import type { Subscriber, SubscriberMessage, SessionChannel } from '../session-channel.js';
import type { Vendor } from '../transcript.js';
import type { ApprovalOption, PendingApprovalInfo } from '../channel-events.js';
import type { TurnIntent } from '../agent-adapter.js';
import {
  applySubscriberMessage,
  createSessionSnapshot,
  type SessionSnapshot,
} from '../session-snapshot.js';
import {
  sendMessage,
  editMessage,
  addReaction,
  createForumPost,
  archiveThread,
  discordFetch,
  triggerTyping,
} from './discord-transport.js';
import { DiscordApiError } from './discord-transport.js';
import { renderSession, getStatusLine, truncate, DISCORD_MAX_LENGTH } from './render.js';

const SOURCE = 'message-view';
const MIN_PROMPT_LENGTH = 3;
const MAX_CHUNKS = 10;

// ---------------------------------------------------------------------------
// Types
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
  snapshot: SessionSnapshot;
  messageIds: string[];
  currentChunks: string[];
  dirty: boolean;
  pendingInteractions: Map<string, PendingInteraction>;
  /** True while syncSession is in-flight (prevents concurrent syncs). */
  syncing: boolean;
  consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const watchedSessions = new Map<string, WatchState>();
const channelToSession = new Map<string, string>();
const commandSessionIds = new Set<string>();

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
  archiveThread(state.discordChannelId).catch(() => {});

  log({ source: SOURCE, level: 'info', summary: `disposed watch for ${sessionId.slice(0, 8)}` });
}

export function disposeAllWatches(): void {
  for (const sessionId of watchedSessions.keys()) {
    disposeWatch(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Watch State Registration
// ---------------------------------------------------------------------------

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
    snapshot: createSessionSnapshot(),
    messageIds: [],
    currentChunks: [],
    dirty: false,
    pendingInteractions: new Map(),
    syncing: false,
    consecutiveFailures: 0,
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
): Promise<{ sessionId: string; discordChannelId: string }> {
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

export async function watchSession(
  sessionId: string,
  forumChannelId: string,
  opts: { auto: boolean },
): Promise<void> {
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
    disposeWatch(sessionId);
    throw err;
  }

  log({ source: SOURCE, level: 'info', summary: `${opts.auto ? 'auto-' : ''}watching session ${sessionId.slice(0, 12)}\u{2026}` });
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
        // Primary lookup by sessionId; fallback by reference identity for rekeyed sessions
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

export function resolveReactionApproval(
  channelId: string,
  messageId: string,
  userId: string,
  emoji: string,
): void {
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
// Render -> Diff -> Sync
// ---------------------------------------------------------------------------

export async function syncSession(state: WatchState): Promise<void> {
  if (state.syncing) {
    log({ source: SOURCE, level: 'debug', summary: `sync skip: ${state.sessionId.slice(0, 8)} already syncing` });
    return;
  }
  state.syncing = true;
  state.dirty = false;

  try {
    const chunks = renderSession(
      state.snapshot.entries,
      state.snapshot.toolResults,
      getStatusLine(state.snapshot.status),
    );

    if (chunks.length > MAX_CHUNKS) {
      log({ source: SOURCE, level: 'info', summary: `sync ${state.sessionId.slice(0, 8)}: truncating ${chunks.length} chunks to ${MAX_CHUNKS}` });
      chunks.splice(0, chunks.length - MAX_CHUNKS);
      chunks[0] = `*... truncated to last ${MAX_CHUNKS} messages*\n${chunks[0]}`;
    }

    log({ source: SOURCE, level: 'info', summary: `sync ${state.sessionId.slice(0, 8)}: ${chunks.length} chunks from ${state.snapshot.entries.length} entries (msgs=${state.messageIds.length}, status=${state.snapshot.status})` });

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

          if (err instanceof DiscordApiError && err.code === 50083) {
            try {
              await discordFetch('PATCH', `/channels/${state.discordChannelId}`, { archived: false });
              log({ source: SOURCE, level: 'warn', summary: `unarchived thread ${state.discordChannelId} — retrying` });
              state.dirty = true;
              return;
            } catch (unarchiveErr) {
              log({ source: SOURCE, level: 'error', summary: `unarchive failed for ${state.discordChannelId}`, data: unarchiveErr });
            }
          }

          state.consecutiveFailures++;
          if ((err instanceof DiscordApiError && err.permanent) || state.consecutiveFailures >= 5) {
            log({ source: SOURCE, level: 'error', summary: `circuit breaker: ${state.sessionId.slice(0, 8)} — disposing watch after ${state.consecutiveFailures} failures` });
            disposeWatch(state.sessionId);
            return;
          }

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

          if (err instanceof DiscordApiError && err.code === 50083) {
            try {
              await discordFetch('PATCH', `/channels/${state.discordChannelId}`, { archived: false });
              log({ source: SOURCE, level: 'warn', summary: `unarchived thread ${state.discordChannelId} — retrying` });
              state.dirty = true;
              return;
            } catch (unarchiveErr) {
              log({ source: SOURCE, level: 'error', summary: `unarchive failed for ${state.discordChannelId}`, data: unarchiveErr });
            }
          }

          state.consecutiveFailures++;
          if ((err instanceof DiscordApiError && err.permanent) || state.consecutiveFailures >= 5) {
            log({ source: SOURCE, level: 'error', summary: `circuit breaker: ${state.sessionId.slice(0, 8)} — disposing watch after ${state.consecutiveFailures} failures` });
            disposeWatch(state.sessionId);
            return;
          }

          state.dirty = true;
          return;
        }
      } else if (!chunk && state.messageIds[i]) {
        await editMessage(state.discordChannelId, state.messageIds[i], '\u{200B}').catch(() => {});
        state.currentChunks[i] = '';
      }
    }

    state.consecutiveFailures = 0;
    state.currentChunks = chunks;
    log({ source: SOURCE, level: 'info', summary: `sync ${state.sessionId.slice(0, 8)}: complete (${chunks.length} chunks, dirty=${state.dirty})` });
  } finally {
    state.syncing = false;
  }
}
