/**
 * Live Discord integration tests — exercises transport + forum mechanics
 * against real Discord. Cleans up after itself.
 *
 * Run: npx vitest run test/discord-live.test.ts
 *
 * Requires a valid bot token + guildId in ~/.crispy/settings.json.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  initTransport,
  shutdownTransport,
  connectGateway,
  disconnectGateway,
  getBotUserId,
  getGuildChannels,
  createForumPost,
  sendMessage,
  editMessage,
  archiveThread,
  discordFetch,
  createChannel,
  deleteChannel,
} from '../src/core/message-view/discord-transport.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DiscordConfig {
  token: string;
  guildId: string;
}

function getConfig(): DiscordConfig | null {
  try {
    const settingsPath = `${process.env.HOME}/.crispy/settings.json`;
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const providers = raw.messageProviders as Array<{ type: string; enabled: boolean; token: string; guildId: string }> | undefined;
    const discord = providers?.find(p => p.type === 'discord' && p.enabled);
    if (!discord) return null;
    return { token: discord.token, guildId: discord.guildId };
  } catch {
    return null;
  }
}

const config = getConfig();
const SKIP = !config;
const GUILD_ID = config?.guildId ?? '';

// Track resources for cleanup
const createdChannels: string[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('Discord live integration', () => {
  afterAll(async () => {
    // Clean up any channels we created
    for (const id of createdChannels) {
      try {
        await deleteChannel(id);
      } catch { /* best-effort */ }
    }
    disconnectGateway();
    shutdownTransport();
  });

  it('connects Gateway and gets bot identity', async () => {
    initTransport(config!.token);

    let ready = false;
    await connectGateway({
      onReady() { ready = true; },
      onMessage() {},
      onReactionAdd() {},
    });

    const start = Date.now();
    while (!ready && Date.now() - start < 15000) {
      await new Promise(r => setTimeout(r, 200));
    }

    expect(ready).toBe(true);
    const botId = getBotUserId();
    expect(botId).toBeTruthy();
    console.log(`Bot ID: ${botId}`);
  }, 20000);

  it('discovers guild channels', async () => {
    const channels = await getGuildChannels(GUILD_ID);
    expect(Array.isArray(channels)).toBe(true);
    expect(channels.length).toBeGreaterThan(0);

    // Log channel types for visibility
    const types = new Map<number, number>();
    for (const ch of channels) {
      types.set(ch.type, (types.get(ch.type) ?? 0) + 1);
    }
    console.log(`Guild has ${channels.length} channels:`, Object.fromEntries(types));
  });

  it('discovers application owner via /oauth2/applications/@me', async () => {
    const app = await discordFetch('GET', '/oauth2/applications/@me') as { owner?: { id: string; username: string } };
    expect(app.owner).toBeDefined();
    expect(app.owner!.id).toBeTruthy();
    console.log(`Application owner: ${app.owner!.username} (${app.owner!.id})`);
  });

  it('creates a forum channel, posts, and cleans up', async () => {
    // Create a test forum channel (type 15)
    const forum = await createChannel(GUILD_ID, 'crispy-test-forum', {
      type: 15,
      topic: 'Integration test — will be deleted',
    });
    createdChannels.push(forum.id);
    expect(forum.id).toBeTruthy();
    expect(forum.name).toBe('crispy-test-forum');
    console.log(`Created forum: ${forum.id}`);

    // Create a forum post
    const post = await createForumPost(forum.id, 'test-session-abc123', '⏳ Starting session…', {
      autoArchiveDuration: 60,
    });
    expect(post.id).toBeTruthy();
    expect(post.name).toBe('test-session-abc123');
    console.log(`Created post: ${post.id}`);

    // Send a message into the post (simulating assistant text)
    const msg = await sendMessage(post.id, '**Assistant:** I will help you fix the auth tests.');
    expect(msg.id).toBeTruthy();

    // Edit the message (simulating tool section update)
    await editMessage(post.id, msg.id, '**Assistant:** I will help you fix the auth tests.\n\n📄 **read**  `auth.test.ts`  ✓');

    // Send another message (simulating tool activity)
    const toolMsg = await sendMessage(post.id, '💻 **bash**  `npm test`  ⏳');
    expect(toolMsg.id).toBeTruthy();

    // Edit tool status (simulating ⏳ → ✓)
    await editMessage(post.id, toolMsg.id, '💻 **bash**  `npm test`  ✓');

    // Archive the post
    await archiveThread(post.id);
    console.log('Post archived successfully');
  }, 30000);

  it('forum post with permission overwrites is accessible', async () => {
    const botId = getBotUserId()!;
    const app = await discordFetch('GET', '/oauth2/applications/@me') as { owner?: { id: string } };
    const ownerId = app.owner?.id;

    // Create forum with the same permission pattern as ensureForumChannel
    const overwrites: unknown[] = [
      { id: GUILD_ID, type: 0, deny: '1024' },
      { id: botId, type: 1, allow: '3072' },
    ];
    if (ownerId) {
      overwrites.push({ id: ownerId, type: 1, allow: '3072' });
    }

    const forum = await createChannel(GUILD_ID, 'crispy-test-perms', {
      type: 15,
      topic: 'Permission test — will be deleted',
      permissionOverwrites: overwrites,
    });
    createdChannels.push(forum.id);
    expect(forum.id).toBeTruthy();

    // Bot should be able to create a post (requires SEND_MESSAGES)
    const post = await createForumPost(forum.id, 'perm-test', 'Bot can post here');
    expect(post.id).toBeTruthy();

    // Bot should be able to send messages in the post
    const msg = await sendMessage(post.id, 'Follow-up message in post');
    expect(msg.id).toBeTruthy();

    // Bot should be able to edit messages (requires SEND_MESSAGES or MANAGE_MESSAGES)
    await editMessage(post.id, msg.id, 'Edited follow-up message');

    console.log('Permission overwrites working — bot can create posts, send, and edit');
    await archiveThread(post.id);
  }, 30000);
});
