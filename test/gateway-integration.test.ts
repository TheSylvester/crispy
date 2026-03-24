/**
 * Gateway integration test — connects to real Discord, verifies READY.
 * Run: npx vitest run test/gateway-integration.test.ts
 *
 * Requires a valid bot token. Skips if not configured.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { initTransport, shutdownTransport, connectGateway, disconnectGateway, getBotUserId } from '../src/core/message-view/discord-transport.js';

function getToken(): string | null {
  try {
    const settingsPath = `${process.env.HOME}/.crispy/settings.json`;
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const providers = raw.messageProviders as Array<{ type: string; enabled: boolean; token: string }> | undefined;
    const discord = providers?.find(p => p.type === 'discord' && p.enabled);
    return discord?.token ?? null;
  } catch {
    return null;
  }
}

const token = getToken();
const SKIP = !token;

describe.skipIf(SKIP)('Gateway integration', () => {
  afterAll(() => {
    disconnectGateway();
    shutdownTransport();
  });

  it('connects to Discord Gateway and receives READY', async () => {
    initTransport(token!);

    let readyReceived = false;
    let botId: string | null = null;

    await connectGateway({
      onReady() {
        readyReceived = true;
        botId = getBotUserId();
      },
      onMessage() {},
      onReactionAdd() {},
    });

    // Wait up to 15 seconds for READY
    const start = Date.now();
    while (!readyReceived && Date.now() - start < 15000) {
      await new Promise(r => setTimeout(r, 200));
    }

    expect(readyReceived).toBe(true);
    expect(botId).toBeTruthy();
    expect(typeof botId).toBe('string');
    console.log(`Gateway READY — bot ID: ${botId}`);
  }, 20000);

  it('getBotUserId returns the cached bot ID after READY', () => {
    const id = getBotUserId();
    expect(id).toBeTruthy();
    expect(id).toBe('1483229916869693500');
  });
});
