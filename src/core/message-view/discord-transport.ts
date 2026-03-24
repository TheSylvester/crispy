/**
 * Discord Transport — Rate-limited REST client for Discord API v10
 *
 * Thin HTTP wrapper with token-bucket rate limiting driven by response headers.
 * No business logic — just authenticated fetch with backoff.
 *
 * @module message-view/discord-transport
 */

import { log } from '../log.js';

const BASE_URL = 'https://discord.com/api/v10';
const MAX_RETRIES = 2;
const SOURCE = 'discord-transport';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let botToken: string | null = null;
let rateLimitRemaining: number | null = null;
let rateLimitResetAfter: number | null = null;
let rateLimitResetAt: number | null = null;

// ---------------------------------------------------------------------------
// Init / Shutdown
// ---------------------------------------------------------------------------

export function initTransport(token: string): void {
  botToken = token;
  rateLimitRemaining = null;
  rateLimitResetAfter = null;
  rateLimitResetAt = null;
  log({ source: SOURCE, level: 'info', summary: 'transport initialized' });
}

export function shutdownTransport(): void {
  botToken = null;
  rateLimitRemaining = null;
  rateLimitResetAfter = null;
  rateLimitResetAt = null;
  log({ source: SOURCE, level: 'info', summary: 'transport shut down' });
}

// ---------------------------------------------------------------------------
// Core fetch with rate limiting
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRateLimitHeaders(headers: Headers): void {
  const remaining = headers.get('X-RateLimit-Remaining');
  const resetAfter = headers.get('X-RateLimit-Reset-After');
  if (remaining != null) rateLimitRemaining = parseInt(remaining, 10);
  if (resetAfter != null) {
    rateLimitResetAfter = parseFloat(resetAfter);
    rateLimitResetAt = Date.now() + rateLimitResetAfter * 1000;
  }
}

async function waitForRateLimit(): Promise<void> {
  if (rateLimitRemaining === 0 && rateLimitResetAt != null) {
    const waitMs = rateLimitResetAt - Date.now();
    if (waitMs > 0) {
      log({ source: SOURCE, level: 'debug', summary: `rate limit: sleeping ${waitMs}ms` });
      await sleep(waitMs);
    }
  }
}

export async function discordFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  if (!botToken) throw new Error('discord transport not initialized');

  await waitForRateLimit();

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
    readRateLimitHeaders(res.headers);

    if (res.status === 429) {
      const json = await res.json() as { retry_after?: number };
      const retryAfter = json.retry_after ?? 1;
      log({ source: SOURCE, level: 'warn', summary: `429 rate limited, retry after ${retryAfter}s (attempt ${attempt + 1})` });
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      const msg = `Discord API error ${res.status}: ${text}`;
      log({ source: SOURCE, level: 'error', summary: msg });
      throw new Error(msg);
    }

    // 204 No Content — return undefined
    if (res.status === 204) return undefined;

    return await res.json();
  }

  throw lastError ?? new Error('discord fetch failed after retries');
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export async function sendMessage(channelId: string, content: string): Promise<{ id: string }> {
  return discordFetch('POST', `/channels/${channelId}/messages`, { content }) as Promise<{ id: string }>;
}

export async function editMessage(channelId: string, messageId: string, content: string): Promise<void> {
  await discordFetch('PATCH', `/channels/${channelId}/messages/${messageId}`, { content });
}

export async function getMessages(
  channelId: string,
  opts?: { after?: string; limit?: number },
): Promise<Array<{ id: string; content: string; author: { id: string; bot?: boolean } }>> {
  const params = new URLSearchParams();
  if (opts?.after) params.set('after', opts.after);
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
  opts?: { parentId?: string; topic?: string; private?: boolean },
): Promise<{ id: string; name: string }> {
  const body: Record<string, unknown> = { name, type: 0 };
  if (opts?.parentId) body.parent_id = opts.parentId;
  if (opts?.topic) body.topic = opts.topic;
  if (opts?.private) {
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

/** Archive a thread (hides it, doesn't delete). */
export async function archiveThread(threadId: string): Promise<void> {
  await discordFetch('PATCH', `/channels/${threadId}`, { archived: true });
}

export async function deleteChannel(channelId: string): Promise<void> {
  await discordFetch('DELETE', `/channels/${channelId}`);
}
