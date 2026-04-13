/**
 * Cloud subcommands — link, unlink, status
 *
 * Manages relay.json config for the cloud tunnel. The daemon reads this
 * file on startup to auto-connect; these commands also notify a running
 * daemon via IPC so changes take effect immediately.
 *
 * @module crispy-cloud
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { relayConfigPath } from '../core/paths.js';

const DEFAULT_RELAY_URL = 'https://crispy-code.com';

interface RelayConfig {
  relayUrl: string;
  pairingToken: string;
  tunnelId: string;
  tunnelName: string;
}

function readConfig(): RelayConfig | null {
  const configPath = relayConfigPath();
  try {
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as RelayConfig;
  } catch {
    return null;
  }
}

function parseFlag(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

async function notifyDaemon(method: string, params: Record<string, unknown> = {}): Promise<unknown | null> {
  try {
    const { discoverSocket, MessageRouter } = await import('./ipc-client.js');
    const { connect } = await import('node:net');
    const socketPath = discoverSocket();
    const conn = connect(socketPath);
    const router = new MessageRouter(conn);
    const result = await router.sendRpc(method, params);
    router.end();
    return result;
  } catch {
    return null;
  }
}

// ---- Subcommands ----

export async function cloudLink(): Promise<void> {
  const token = process.argv[4];
  if (!token) {
    console.error('Usage: crispy cloud link <pairing-token> [--relay <url>] [--name <name>]');
    process.exit(1);
  }

  if (!token.startsWith('crsp_')) {
    console.error('Invalid pairing token — must start with "crsp_"');
    process.exit(1);
  }

  const relayUrl = parseFlag('--relay') || DEFAULT_RELAY_URL;
  const tunnelName = parseFlag('--name') || hostname();

  const existing = readConfig();
  if (existing) {
    console.log('Replacing existing relay link.');
  }

  const config: RelayConfig = {
    relayUrl,
    pairingToken: token,
    tunnelId: randomUUID(),
    tunnelName,
  };

  writeFileSync(relayConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });

  // Notify running daemon
  const result = await notifyDaemon('updateRelayConfig', { ...config });
  if (result) {
    console.log(`Linked to relay at ${relayUrl} as '${tunnelName}' (daemon notified)`);
  } else {
    console.log(`Linked to relay at ${relayUrl} as '${tunnelName}'`);
    console.log('Daemon not running — tunnel will connect on next start.');
  }
}

export async function cloudUnlink(): Promise<void> {
  const configPath = relayConfigPath();
  if (!existsSync(configPath)) {
    console.log('Not linked to a relay.');
    return;
  }

  try { unlinkSync(configPath); } catch { /* already gone */ }

  const result = await notifyDaemon('disconnectRelay');
  if (result) {
    console.log('Unlinked from relay (daemon notified).');
  } else {
    console.log('Unlinked from relay.');
  }
}

export async function cloudStatus(): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.log('Not linked to a relay.');
    return;
  }

  console.log(`Relay:     ${config.relayUrl}`);
  console.log(`Name:      ${config.tunnelName}`);
  console.log(`Tunnel ID: ${config.tunnelId}`);

  // Query daemon for live tunnel status
  try {
    const { discoverSocket, MessageRouter } = await import('./ipc-client.js');
    const { connect } = await import('node:net');
    const socketPath = discoverSocket();
    const conn = connect(socketPath);
    const router = new MessageRouter(conn);
    const result = await router.sendRpc('getRelayConfig', {}) as { status?: string } | null;
    router.end();
    if (result && result.status) {
      console.log(`Tunnel:    ${result.status}`);
    }
  } catch {
    console.log('Tunnel:    daemon not running — inactive');
  }
}

export async function runCloud(): Promise<void> {
  const subcommand = process.argv[3] || '';

  switch (subcommand) {
    case 'link':    return cloudLink();
    case 'unlink':  return cloudUnlink();
    case 'status':  return cloudStatus();
    default:
      console.log(`
Usage: crispy cloud <subcommand>

Subcommands:
  link <token>   Link this machine to a cloud relay
  unlink         Remove relay link
  status         Show relay connection status

Options (for link):
  --relay <url>  Relay server URL (default: ${DEFAULT_RELAY_URL})
  --name <name>  Machine name (default: hostname)
`.trim());
      if (subcommand) {
        console.error(`\nUnknown subcommand: ${subcommand}`);
        process.exit(1);
      }
  }
}
