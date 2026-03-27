/**
 * Tests for Discord Transport — REST wrappers and module state
 *
 * Mocks global `fetch` to verify request construction without a real Discord connection.
 * Tests cover: bot identity, createForumPost, getGuildChannels, createChannel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  initTransport,
  shutdownTransport,
  getBotUserId,
  discordFetch,
  createForumPost,
  getGuildChannels,
  createChannel,
} from '../src/core/message-view/discord-transport.js';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  shutdownTransport();
  vi.unstubAllGlobals();
});

/** Build a minimal successful Response for the mock. */
function okResponse(body: unknown, headers?: Record<string, string>): Response {
  const h = new Headers(headers);
  return {
    ok: true,
    status: 200,
    headers: h,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Bot identity
// ---------------------------------------------------------------------------

describe('getBotUserId', () => {
  it('returns null before init', () => {
    // No initTransport called — module state is reset by shutdownTransport in afterEach
    expect(getBotUserId()).toBeNull();
  });

  it('returns null after init but before any API call populates it', () => {
    initTransport('fake-token');
    expect(getBotUserId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createForumPost
// ---------------------------------------------------------------------------

describe('createForumPost', () => {
  beforeEach(() => {
    initTransport('test-token');
  });

  it('sends POST to /channels/{forumId}/threads with correct body', async () => {
    const responseBody = { id: 'thread-123', name: 'My Post', message: { id: 'msg-001' } };
    mockFetch.mockResolvedValueOnce(okResponse(responseBody));

    const result = await createForumPost('forum-456', 'My Post', 'Hello world');

    expect(result).toEqual({ id: 'thread-123', name: 'My Post', messageId: 'msg-001' });
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://discord.com/api/v10/channels/forum-456/threads');
    expect(init?.method).toBe('POST');

    const body = JSON.parse(init?.body as string);
    expect(body.name).toBe('My Post');
    expect(body.message).toEqual({ content: 'Hello world' });
    // No optional fields when not provided
    expect(body.auto_archive_duration).toBeUndefined();
    expect(body.applied_tags).toBeUndefined();
  });

  it('includes autoArchiveDuration and appliedTags when provided', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ id: 't-1', name: 'Tagged' }));

    await createForumPost('forum-789', 'Tagged', 'content', {
      autoArchiveDuration: 1440,
      appliedTags: ['tag-a', 'tag-b'],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.auto_archive_duration).toBe(1440);
    expect(body.applied_tags).toEqual(['tag-a', 'tag-b']);
  });

  it('truncates name to 100 characters', async () => {
    const longName = 'A'.repeat(150);
    mockFetch.mockResolvedValueOnce(okResponse({ id: 't-2', name: longName.slice(0, 100) }));

    await createForumPost('forum-1', longName, 'body');

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.name).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// getGuildChannels
// ---------------------------------------------------------------------------

describe('getGuildChannels', () => {
  beforeEach(() => {
    initTransport('test-token');
  });

  it('calls GET /guilds/{guildId}/channels', async () => {
    const channels = [
      { id: 'ch-1', name: 'general', type: 0 },
      { id: 'ch-2', name: 'sessions', type: 15 },
    ];
    mockFetch.mockResolvedValueOnce(okResponse(channels));

    const result = await getGuildChannels('guild-42');

    expect(result).toEqual(channels);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://discord.com/api/v10/guilds/guild-42/channels');
    expect(init?.method).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// createChannel
// ---------------------------------------------------------------------------

describe('createChannel', () => {
  beforeEach(() => {
    initTransport('test-token');
  });

  it('defaults type to 0 (text channel)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ id: 'ch-new', name: 'test' }));

    await createChannel('guild-1', 'test');

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.type).toBe(0);
    expect(body.name).toBe('test');
  });

  it('passes custom type (e.g. 15 for forum)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ id: 'ch-forum', name: 'forum' }));

    await createChannel('guild-1', 'forum', { type: 15 });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.type).toBe(15);
  });

  it('includes permissionOverwrites when provided', async () => {
    const overwrites = [
      { id: 'role-1', type: 0, deny: '1024' },
      { id: 'role-2', type: 1, allow: '2048' },
    ];
    mockFetch.mockResolvedValueOnce(okResponse({ id: 'ch-priv', name: 'private' }));

    await createChannel('guild-1', 'private', { permissionOverwrites: overwrites });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.permission_overwrites).toEqual(overwrites);
  });

  it('generates @everyone deny overwrite when private=true and no explicit overwrites', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ id: 'ch-p', name: 'secret' }));

    await createChannel('guild-1', 'secret', { private: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.permission_overwrites).toEqual([
      { id: 'guild-1', type: 0, deny: '1024' },
    ]);
  });

  it('explicit permissionOverwrites take precedence over private flag', async () => {
    const overwrites = [{ id: 'custom', type: 0, deny: '999' }];
    mockFetch.mockResolvedValueOnce(okResponse({ id: 'ch-x', name: 'x' }));

    await createChannel('guild-1', 'x', { private: true, permissionOverwrites: overwrites });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.permission_overwrites).toEqual(overwrites);
  });

  it('includes parentId and topic when provided', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ id: 'ch-sub', name: 'sub' }));

    await createChannel('guild-1', 'sub', { parentId: 'cat-1', topic: 'My topic' });

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.parent_id).toBe('cat-1');
    expect(body.topic).toBe('My topic');
  });
});

// ---------------------------------------------------------------------------
// discordFetch — error handling and auth
// ---------------------------------------------------------------------------

describe('discordFetch', () => {
  it('throws when transport not initialized', async () => {
    // No initTransport called
    await expect(discordFetch('GET', '/test')).rejects.toThrow('discord transport not initialized');
  });

  it('includes Bot authorization header', async () => {
    initTransport('my-secret-token');
    mockFetch.mockResolvedValueOnce(okResponse({ ok: true }));

    await discordFetch('GET', '/users/@me');

    const [, init] = mockFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bot my-secret-token');
  });

  it('throws on non-ok response', async () => {
    initTransport('tok');
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: () => Promise.resolve('Forbidden'),
    } as unknown as Response);

    await expect(discordFetch('GET', '/bad')).rejects.toThrow('Discord API error 403: Forbidden');
  });

  it('returns undefined for 204 No Content', async () => {
    initTransport('tok');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: new Headers(),
    } as unknown as Response);

    const result = await discordFetch('PUT', '/reactions');
    expect(result).toBeUndefined();
  });

  it('retries on 429 rate limit', async () => {
    initTransport('tok');

    // First call returns 429
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers(),
      json: () => Promise.resolve({ retry_after: 0.01 }),
    } as unknown as Response);

    // Second call succeeds
    mockFetch.mockResolvedValueOnce(okResponse({ success: true }));

    const result = await discordFetch('GET', '/test');
    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
