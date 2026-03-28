/**
 * Discord Transport — REST client + Gateway WebSocket for Discord API v10
 *
 * REST: authenticated fetch with per-route rate limiting driven by response headers.
 * Gateway: outbound WebSocket for real-time event delivery (messages, reactions, DMs).
 * All writes go through REST; Gateway is read-only event reception.
 *
 * @module message-view/discord-transport
 */

import { WebSocket } from 'ws';
import { log } from '../log.js';

const BASE_URL = 'https://discord.com/api/v10';
const MAX_RETRIES = 2;
const SOURCE = 'discord-transport';

export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | null,
    public readonly body: string,
  ) {
    super(`Discord API error ${status}: ${body}`);
    this.name = 'DiscordApiError';
  }

  get permanent(): boolean {
    if (this.status === 403 || this.status === 404) return true;
    if (this.status === 400 && this.code != null) {
      return [50083, 50001, 10003].includes(this.code);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gateway constants
// ---------------------------------------------------------------------------

const GatewayOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

const GatewayIntents =
  (1 << 0)  | // GUILDS
  (1 << 9)  | // GUILD_MESSAGES
  (1 << 12) | // DIRECT_MESSAGES
  (1 << 15);  // MESSAGE_CONTENT (privileged)

const GATEWAY_RECONNECT_BASE_MS = 1000;
const GATEWAY_RECONNECT_MAX_MS = 30000;

// ---------------------------------------------------------------------------
// Gateway types
// ---------------------------------------------------------------------------

export interface DiscordInteraction {
  id: string;
  token: string;
  type: number;
  data?: { custom_id: string; component_type: number };
  channel_id: string;
  message?: { id: string };
  member?: { user: { id: string } };
  user?: { id: string };
  guild_id?: string;
}

export interface MessageComponent {
  type: number;           // 1 = ActionRow, 2 = Button
  components?: MessageComponent[];  // ActionRow children
  style?: number;         // Button: 1=Primary, 2=Secondary, 3=Success, 4=Danger
  label?: string;
  custom_id?: string;
  disabled?: boolean;
  emoji?: { name: string };
}

export interface GatewayEventHandler {
  onMessage(channelId: string, message: {
    id: string;
    content: string;
    author: { id: string; bot?: boolean };
    guild_id?: string;
    mentions?: Array<{ id: string }>;
  }): void;
  onReactionAdd?(channelId: string, messageId: string, userId: string, emoji: string): void;
  onInteraction?(interaction: DiscordInteraction): void;
  onThreadCreate?(event: { id: string; parent_id: string; name: string; guild_id: string; owner_id?: string }): void;
  onReady(): void;
  onDisconnect?(): void;
  onReconnect?(): void;
}

// ---------------------------------------------------------------------------
// Module state — REST
// ---------------------------------------------------------------------------

let botToken: string | null = null;

/** Per-route rate limit buckets keyed by Discord's opaque bucket hash. */
const rateLimitBuckets = new Map<string, { remaining: number; resetAt: number }>();

/** Maps route keys (e.g. "GET /channels/123/messages") to bucket hashes. */
const routeToBucket = new Map<string, string>();

// ---------------------------------------------------------------------------
// Module state — Gateway
// ---------------------------------------------------------------------------

let gatewayWs: WebSocket | null = null;
let gatewaySessionId: string | null = null;
let gatewaySequence: number | null = null;
let gatewayHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let gatewayHeartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null;
let gatewayHeartbeatAcked = true;
let gatewayResumeUrl: string | null = null;
let gatewayHandler: GatewayEventHandler | null = null;
let gatewayReconnectAttempts = 0;
let gatewayIntentionalClose = false;

// ---------------------------------------------------------------------------
// Module state — Bot identity
// ---------------------------------------------------------------------------

let cachedBotUserId: string | null = null;

// ---------------------------------------------------------------------------
// Init / Shutdown
// ---------------------------------------------------------------------------

export function initTransport(token: string): void {
  botToken = token;
  rateLimitBuckets.clear();
  routeToBucket.clear();
  cachedBotUserId = null;
  log({ source: SOURCE, level: 'info', summary: 'transport initialized' });
}

export function shutdownTransport(): void {
  disconnectGateway();
  botToken = null;
  rateLimitBuckets.clear();
  routeToBucket.clear();
  cachedBotUserId = null;
  log({ source: SOURCE, level: 'info', summary: 'transport shut down' });
}

// ---------------------------------------------------------------------------
// Bot identity
// ---------------------------------------------------------------------------

export function getBotUserId(): string | null {
  return cachedBotUserId;
}

export async function getBotUser(): Promise<{ id: string; username: string }> {
  const result = await discordFetch('GET', '/users/@me') as { id: string; username: string };
  cachedBotUserId = result.id;
  return result;
}

// ---------------------------------------------------------------------------
// Per-route rate limiting
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Derive a route key for rate limit bucketing. Major params (channel, guild) are included. */
function routeKey(method: string, path: string): string {
  // Discord shares buckets per major resource (channel_id, guild_id, webhook_id).
  // Normalize path to keep major params but strip minor IDs.
  return `${method} ${path}`;
}

function readRateLimitHeaders(headers: Headers, rKey: string): void {
  const bucket = headers.get('X-RateLimit-Bucket');
  const remaining = headers.get('X-RateLimit-Remaining');
  const resetAfter = headers.get('X-RateLimit-Reset-After');

  if (bucket) {
    routeToBucket.set(rKey, bucket);
    if (remaining != null && resetAfter != null) {
      rateLimitBuckets.set(bucket, {
        remaining: parseInt(remaining, 10),
        resetAt: Date.now() + parseFloat(resetAfter) * 1000,
      });
    }
  }
}

async function waitForRateLimit(rKey: string): Promise<void> {
  // Evict stale buckets periodically to prevent unbounded growth
  if (rateLimitBuckets.size > 100) {
    const now = Date.now();
    for (const [key, val] of rateLimitBuckets) {
      if (val.resetAt < now) rateLimitBuckets.delete(key);
    }
  }

  const bucket = routeToBucket.get(rKey);
  if (!bucket) return;

  const state = rateLimitBuckets.get(bucket);
  if (!state) return;

  if (state.remaining === 0) {
    const waitMs = state.resetAt - Date.now();
    if (waitMs > 0) {
      log({ source: SOURCE, level: 'debug', summary: `rate limit [${bucket.slice(0, 8)}]: sleeping ${waitMs}ms` });
      await sleep(waitMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Core fetch with rate limiting
// ---------------------------------------------------------------------------

export async function discordFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  if (!botToken) throw new Error('discord transport not initialized');

  const rKey = routeKey(method, path);
  await waitForRateLimit(rKey);

  const url = `${BASE_URL}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'Authorization': `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  log({ source: SOURCE, level: 'debug', summary: `${method} ${path}` });

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);
    readRateLimitHeaders(res.headers, rKey);

    if (res.status === 429) {
      const json = await res.json() as { retry_after?: number };
      const retryAfter = json.retry_after ?? 1;
      log({ source: SOURCE, level: 'warn', summary: `429 rate limited, retry after ${retryAfter}s (attempt ${attempt + 1})` });
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      let code: number | null = null;
      try { code = JSON.parse(text).code ?? null; } catch { /* not JSON */ }
      const err = new DiscordApiError(res.status, code, text);
      log({ source: SOURCE, level: 'error', summary: err.message });
      throw err;
    }

    // 204 No Content — return undefined
    if (res.status === 204) return undefined;

    return await res.json();
  }

  throw lastError ?? new Error('discord fetch failed after retries');
}

// ---------------------------------------------------------------------------
// Gateway — connect / disconnect / reconnect
// ---------------------------------------------------------------------------

export async function connectGateway(handler: GatewayEventHandler): Promise<void> {
  if (!botToken) throw new Error('discord transport not initialized');
  gatewayHandler = handler;
  gatewayIntentionalClose = false;
  gatewayReconnectAttempts = 0;

  // Fetch the Gateway URL
  const gatewayInfo = await discordFetch('GET', '/gateway/bot') as { url: string };
  const wsUrl = `${gatewayInfo.url}/?v=10&encoding=json`;

  log({ source: SOURCE, level: 'info', summary: `gateway connecting to ${gatewayInfo.url}` });
  openGatewaySocket(wsUrl);
}

export function disconnectGateway(): void {
  gatewayIntentionalClose = true;
  gatewayHandler = null;

  if (gatewayHeartbeatJitterTimer) { clearTimeout(gatewayHeartbeatJitterTimer); gatewayHeartbeatJitterTimer = null; }
  if (gatewayHeartbeatTimer) { clearInterval(gatewayHeartbeatTimer); gatewayHeartbeatTimer = null; }

  if (gatewayWs) {
    try {
      gatewayWs.removeAllListeners();
      gatewayWs.close(1000, 'shutdown');
    } catch { /* best-effort */ }
    gatewayWs = null;
  }

  gatewaySessionId = null;
  gatewaySequence = null;
  gatewayResumeUrl = null;
  gatewayHeartbeatAcked = true;
  gatewayReconnectAttempts = 0;

  log({ source: SOURCE, level: 'info', summary: 'gateway disconnected' });
}

function openGatewaySocket(url: string): void {
  if (gatewayWs) {
    try { gatewayWs.removeAllListeners(); gatewayWs.close(1000); } catch { /* best-effort */ }
    gatewayWs = null;
  }

  const ws = new WebSocket(url);
  gatewayWs = ws;

  ws.on('open', () => {
    log({ source: SOURCE, level: 'debug', summary: 'gateway socket opened' });
  });

  ws.on('message', (data) => {
    try {
      const payload = JSON.parse(String(data)) as {
        op: number;
        d: unknown;
        s: number | null;
        t: string | null;
      };
      handleGatewayPayload(payload);
    } catch (err) {
      log({ source: SOURCE, level: 'error', summary: 'gateway message parse error', data: err });
    }
  });

  ws.on('close', (code, reason) => {
    log({ source: SOURCE, level: 'warn', summary: `gateway closed: ${code} ${String(reason)}` });

    if (gatewayHeartbeatJitterTimer) { clearTimeout(gatewayHeartbeatJitterTimer); gatewayHeartbeatJitterTimer = null; }
    if (gatewayHeartbeatTimer) { clearInterval(gatewayHeartbeatTimer); gatewayHeartbeatTimer = null; }

    if (gatewayIntentionalClose) return;

    gatewayHandler?.onDisconnect?.();
    scheduleGatewayReconnect();
  });

  ws.on('error', (err) => {
    log({ source: SOURCE, level: 'error', summary: 'gateway socket error', data: err });
  });
}

function handleGatewayPayload(payload: { op: number; d: unknown; s: number | null; t: string | null }): void {
  // Update sequence number for heartbeats and resume
  if (payload.s != null) gatewaySequence = payload.s;

  switch (payload.op) {
    case GatewayOpcode.HELLO: {
      const hello = payload.d as { heartbeat_interval: number };
      startGatewayHeartbeat(hello.heartbeat_interval);

      // Identify or resume
      if (gatewaySessionId && gatewaySequence != null) {
        sendGatewayResume();
      } else {
        sendGatewayIdentify();
      }
      break;
    }

    case GatewayOpcode.HEARTBEAT_ACK:
      gatewayHeartbeatAcked = true;
      break;

    case GatewayOpcode.HEARTBEAT:
      // Server requested an immediate heartbeat
      sendGatewayHeartbeat();
      break;

    case GatewayOpcode.DISPATCH:
      handleGatewayDispatch(payload.t!, payload.d);
      break;

    case GatewayOpcode.RECONNECT:
      log({ source: SOURCE, level: 'info', summary: 'gateway: server requested reconnect' });
      gatewayWs?.close(4000, 'reconnect requested');
      break;

    case GatewayOpcode.INVALID_SESSION: {
      const resumable = payload.d as boolean;
      log({ source: SOURCE, level: 'warn', summary: `gateway: invalid session (resumable=${resumable})` });
      if (!resumable) {
        // Clear session state — next connect will do a fresh identify
        gatewaySessionId = null;
        gatewaySequence = null;
        gatewayResumeUrl = null;
      }
      // Wait 1-5 seconds as per Discord docs before reconnecting
      const delay = 1000 + Math.random() * 4000;
      setTimeout(() => {
        if (!gatewayIntentionalClose) {
          scheduleGatewayReconnect();
        }
      }, delay);
      break;
    }

    default:
      log({ source: SOURCE, level: 'debug', summary: `gateway: unhandled opcode ${payload.op}` });
  }
}

function handleGatewayDispatch(eventName: string, data: unknown): void {
  if (!gatewayHandler) return;

  switch (eventName) {
    case 'READY': {
      const ready = data as {
        session_id: string;
        resume_gateway_url: string;
        user: { id: string; username: string };
      };
      gatewaySessionId = ready.session_id;
      gatewayResumeUrl = ready.resume_gateway_url;
      gatewayReconnectAttempts = 0;

      // Populate bot identity from READY payload
      cachedBotUserId = ready.user.id;

      log({ source: SOURCE, level: 'info', summary: `gateway ready: bot=${ready.user.username} (${ready.user.id})` });
      gatewayHandler.onReady();
      break;
    }

    case 'RESUMED':
      gatewayReconnectAttempts = 0;
      log({ source: SOURCE, level: 'info', summary: 'gateway resumed' });
      gatewayHandler.onReconnect?.();
      break;

    case 'MESSAGE_CREATE': {
      const msg = data as {
        id: string;
        content: string;
        channel_id: string;
        author: { id: string; bot?: boolean };
        guild_id?: string;
        mentions?: Array<{ id: string }>;
      };
      gatewayHandler.onMessage(msg.channel_id, {
        id: msg.id,
        content: msg.content,
        author: msg.author,
        guild_id: msg.guild_id,
        mentions: msg.mentions,
      });
      break;
    }

    case 'MESSAGE_REACTION_ADD': {
      const reaction = data as {
        channel_id: string;
        message_id: string;
        user_id: string;
        emoji: { name: string | null; id: string | null };
      };
      // Normalize emoji: custom = id, unicode = name
      const emoji = reaction.emoji.id
        ? `${reaction.emoji.name}:${reaction.emoji.id}`
        : (reaction.emoji.name ?? '');
      gatewayHandler.onReactionAdd?.(reaction.channel_id, reaction.message_id, reaction.user_id, emoji);
      break;
    }

    case 'INTERACTION_CREATE': {
      const interaction = data as DiscordInteraction;
      if (interaction.type === 3 && interaction.data) {
        gatewayHandler.onInteraction?.(interaction);
      }
      break;
    }

    case 'THREAD_CREATE': {
      const d = data as {
        id: string;
        parent_id: string;
        name: string;
        guild_id: string;
        owner_id?: string;
      };
      if (gatewayHandler?.onThreadCreate) {
        gatewayHandler.onThreadCreate({
          id: d.id,
          parent_id: d.parent_id,
          name: d.name,
          guild_id: d.guild_id,
          owner_id: d.owner_id,
        });
      }
      break;
    }

    default:
      log({ source: SOURCE, level: 'debug', summary: `gateway dispatch: ${eventName}` });
  }
}

// ---------------------------------------------------------------------------
// Gateway — heartbeat
// ---------------------------------------------------------------------------

function startGatewayHeartbeat(intervalMs: number): void {
  if (gatewayHeartbeatJitterTimer) { clearTimeout(gatewayHeartbeatJitterTimer); gatewayHeartbeatJitterTimer = null; }
  if (gatewayHeartbeatTimer) { clearInterval(gatewayHeartbeatTimer); gatewayHeartbeatTimer = null; }

  gatewayHeartbeatAcked = true;

  // First heartbeat after jitter (Discord requirement)
  const jitter = Math.random() * intervalMs;
  gatewayHeartbeatJitterTimer = setTimeout(() => {
    gatewayHeartbeatJitterTimer = null;
    sendGatewayHeartbeat();

    gatewayHeartbeatTimer = setInterval(() => {
      if (!gatewayHeartbeatAcked) {
        log({ source: SOURCE, level: 'warn', summary: 'gateway: heartbeat ACK missed — reconnecting' });
        gatewayWs?.close(4000, 'heartbeat timeout');
        return;
      }
      sendGatewayHeartbeat();
    }, intervalMs);
  }, jitter);
}

function sendGatewayHeartbeat(): void {
  if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) return;
  gatewayHeartbeatAcked = false;
  gatewayWs.send(JSON.stringify({ op: GatewayOpcode.HEARTBEAT, d: gatewaySequence }));
}

// ---------------------------------------------------------------------------
// Gateway — identify / resume
// ---------------------------------------------------------------------------

function sendGatewayIdentify(): void {
  if (!gatewayWs || !botToken) return;

  const payload = {
    op: GatewayOpcode.IDENTIFY,
    d: {
      token: botToken,
      intents: GatewayIntents,
      properties: {
        os: 'linux',
        browser: 'crispy',
        device: 'crispy',
      },
    },
  };
  gatewayWs.send(JSON.stringify(payload));
  log({ source: SOURCE, level: 'debug', summary: 'gateway: sent identify' });
}

function sendGatewayResume(): void {
  if (!gatewayWs || !botToken || !gatewaySessionId) return;

  const payload = {
    op: GatewayOpcode.RESUME,
    d: {
      token: botToken,
      session_id: gatewaySessionId,
      seq: gatewaySequence,
    },
  };
  gatewayWs.send(JSON.stringify(payload));
  log({ source: SOURCE, level: 'debug', summary: `gateway: sent resume (seq=${gatewaySequence})` });
}

// ---------------------------------------------------------------------------
// Gateway — reconnect with backoff
// ---------------------------------------------------------------------------

function scheduleGatewayReconnect(): void {
  if (gatewayIntentionalClose || !botToken) return;

  const delay = Math.min(
    GATEWAY_RECONNECT_BASE_MS * Math.pow(2, gatewayReconnectAttempts),
    GATEWAY_RECONNECT_MAX_MS,
  );
  gatewayReconnectAttempts++;

  log({ source: SOURCE, level: 'info', summary: `gateway: reconnecting in ${delay}ms (attempt ${gatewayReconnectAttempts})` });

  setTimeout(() => {
    if (gatewayIntentionalClose || !botToken) return;

    // Use resume URL if available, otherwise fetch fresh
    const url = gatewayResumeUrl
      ? `${gatewayResumeUrl}/?v=10&encoding=json`
      : null;

    if (url) {
      openGatewaySocket(url);
    } else {
      // Fetch a fresh gateway URL
      discordFetch('GET', '/gateway/bot')
        .then((info) => {
          if (gatewayIntentionalClose) return;
          const wsUrl = `${(info as { url: string }).url}/?v=10&encoding=json`;
          openGatewaySocket(wsUrl);
        })
        .catch((err) => {
          log({ source: SOURCE, level: 'error', summary: 'gateway: failed to fetch URL for reconnect', data: err });
          scheduleGatewayReconnect();
        });
    }
  }, delay);
}

// ---------------------------------------------------------------------------
// Convenience wrappers — REST
// ---------------------------------------------------------------------------

/** Trigger the "Bot is typing..." indicator for up to 10 seconds. Fire-and-forget. */
export async function triggerTyping(channelId: string): Promise<void> {
  await discordFetch('POST', `/channels/${channelId}/typing`);
}

export async function sendMessage(channelId: string, content: string): Promise<{ id: string }> {
  return discordFetch('POST', `/channels/${channelId}/messages`, { content }) as Promise<{ id: string }>;
}

export async function editMessage(channelId: string, messageId: string, content: string): Promise<void> {
  await discordFetch('PATCH', `/channels/${channelId}/messages/${messageId}`, { content });
}

export async function editMessageWithComponents(
  channelId: string,
  messageId: string,
  content: string,
  components: MessageComponent[],
): Promise<void> {
  await discordFetch('PATCH', `/channels/${channelId}/messages/${messageId}`, { content, components });
}

export async function deleteMessage(channelId: string, messageId: string): Promise<void> {
  await discordFetch('DELETE', `/channels/${channelId}/messages/${messageId}`);
}

export async function getMessages(
  channelId: string,
  opts?: { after?: string; before?: string; limit?: number },
): Promise<Array<{ id: string; content: string; author: { id: string; bot?: boolean } }>> {
  const params = new URLSearchParams();
  if (opts?.after) params.set('after', opts.after);
  if (opts?.before) params.set('before', opts.before);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const path = `/channels/${channelId}/messages${qs ? `?${qs}` : ''}`;
  return discordFetch('GET', path) as Promise<Array<{ id: string; content: string; author: { id: string; bot?: boolean } }>>;
}

export async function addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
  const encoded = encodeURIComponent(emoji);
  await discordFetch('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`);
}

export async function getReactions(
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<Array<{ id: string }>> {
  const encoded = encodeURIComponent(emoji);
  return discordFetch('GET', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}`) as Promise<Array<{ id: string }>>;
}

export async function createChannel(
  guildId: string,
  name: string,
  opts?: { parentId?: string; topic?: string; private?: boolean; type?: number; permissionOverwrites?: unknown[] },
): Promise<{ id: string; name: string }> {
  const body: Record<string, unknown> = { name, type: opts?.type ?? 0 };
  if (opts?.parentId) body.parent_id = opts.parentId;
  if (opts?.topic) body.topic = opts.topic;
  if (opts?.permissionOverwrites) {
    body.permission_overwrites = opts.permissionOverwrites;
  } else if (opts?.private) {
    // Deny VIEW_CHANNEL (0x400) for @everyone (role ID = guild ID)
    body.permission_overwrites = [
      { id: guildId, type: 0, deny: '1024' },
    ];
  }
  return discordFetch('POST', `/guilds/${guildId}/channels`, body) as Promise<{ id: string; name: string }>;
}

/**
 * Create a thread from a message. The thread ID is a channel ID —
 * sendMessage/editMessage/getMessages work on it directly.
 */
export async function createThread(
  channelId: string,
  messageId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  return discordFetch('POST', `/channels/${channelId}/messages/${messageId}/threads`, {
    name: name.slice(0, 100), // Discord thread name limit
  }) as Promise<{ id: string; name: string }>;
}

/**
 * Create a forum post (thread in a forum channel).
 * Endpoint: POST /channels/{forumChannelId}/threads
 *
 * Discord returns the starter message in the response's `message` field.
 * `messageId` is the starter message ID — used to seed the first ThreadSlot.
 */
export async function createForumPost(
  forumChannelId: string,
  name: string,
  message: string,
  opts?: { autoArchiveDuration?: number; appliedTags?: string[]; components?: MessageComponent[] },
): Promise<{ id: string; name: string; messageId: string }> {
  const msg: Record<string, unknown> = { content: message };
  if (opts?.components) msg.components = opts.components;
  const body: Record<string, unknown> = {
    name: name.slice(0, 100),
    message: msg,
  };
  if (opts?.autoArchiveDuration) body.auto_archive_duration = opts.autoArchiveDuration;
  if (opts?.appliedTags) body.applied_tags = opts.appliedTags;
  const result = await discordFetch('POST', `/channels/${forumChannelId}/threads`, body) as {
    id: string;
    name: string;
    message?: { id: string };
  };
  return {
    id: result.id,
    name: result.name,
    messageId: result.message?.id ?? '',
  };
}

/** Archive a thread (hides it, doesn't delete). */
export async function archiveThread(threadId: string): Promise<void> {
  await discordFetch('PATCH', `/channels/${threadId}`, { archived: true });
}

export async function deleteChannel(channelId: string): Promise<void> {
  await discordFetch('DELETE', `/channels/${channelId}`);
}


export async function getGuildChannels(guildId: string): Promise<Array<{ id: string; name: string; type: number }>> {
  return discordFetch('GET', `/guilds/${guildId}/channels`) as Promise<Array<{ id: string; name: string; type: number }>>;
}

// ---------------------------------------------------------------------------
// Message Components (buttons) + Interaction responses
// ---------------------------------------------------------------------------

export async function sendMessageWithComponents(
  channelId: string,
  content: string,
  components: MessageComponent[],
): Promise<{ id: string }> {
  return discordFetch('POST', `/channels/${channelId}/messages`, {
    content,
    components,
  }) as Promise<{ id: string }>;
}

/**
 * Respond to a Discord interaction (button click).
 * Type 4 = CHANNEL_MESSAGE_WITH_SOURCE (reply with message)
 * Type 6 = DEFERRED_UPDATE_MESSAGE (ack, no visible change)
 * Type 7 = UPDATE_MESSAGE (edit the original message)
 *
 * Interaction responses use a DIFFERENT endpoint from normal REST calls.
 * No Bot auth header — the interaction token IS the auth.
 */
export async function respondToInteraction(
  interactionId: string,
  interactionToken: string,
  response: { type: number; data?: { content?: string; components?: MessageComponent[]; flags?: number } },
): Promise<void> {
  const res = await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  });
  if (!res.ok) {
    const text = await res.text();
    log({ source: SOURCE, level: 'error', summary: `interaction response failed: ${res.status} ${text}` });
  }
}
