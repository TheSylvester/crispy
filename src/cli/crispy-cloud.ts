/**
 * Cloud subcommands — link, unlink, status
 *
 * Manages tunnel config via settings.json (source of truth). When the daemon
 * is running, notifies it via IPC so changes take effect immediately.
 * When offline, patches settings.json directly.
 *
 * Legacy relay.json is read only for status fallback (pre-migration installs).
 *
 * @module crispy-cloud
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { settingsPath, relayConfigPath } from '../core/paths.js';

const DEFAULT_RELAY_URL = 'https://crispy-code.com';

interface RelayConfig {
  relayUrl: string;
  pairingToken: string;
  tunnelId: string;
  tunnelName: string;
}

/** Read legacy relay.json for status fallback. */
function readLegacyConfig(): RelayConfig | null {
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

/** Read-modify-write settings.json when daemon is offline. */
function patchSettingsFile(patch: Record<string, unknown>): void {
  const path = settingsPath();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Corrupt JSON — rename to .corrupt backup, then start with empty settings
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      try { renameSync(path, `${path}.corrupt.${timestamp}`); } catch { /* best effort */ }
    }
    settings = { version: 1 };
  }
  // Deep-merge patch keys (top-level, matching settings-store behavior)
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'object' && value && typeof settings[key] === 'object' && settings[key]) {
      settings[key] = { ...(settings[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      settings[key] = value;
    }
  }
  settings.revision = ((settings.revision as number) || 0) + 1;
  settings.updatedAt = new Date().toISOString();
  if (!settings.version) settings.version = 1;
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
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

  const config = {
    enabled: true,
    relayUrl,
    pairingToken: token,
    tunnelId: randomUUID(),
    tunnelName,
    enableInDevServer: true,
    enableInDaemon: true,
    enableInTauri: true,
    enableInVscode: false,
  };

  // Try daemon first (it owns settings persistence and live reconnect)
  const result = await notifyDaemon('updateRelayConfig', config);
  if (result) {
    console.log(`Linked to relay at ${relayUrl} as '${tunnelName}' (daemon notified)`);
  } else {
    // Daemon not running — patch settings.json directly
    patchSettingsFile({ tunnel: config });
    console.log(`Linked to relay at ${relayUrl} as '${tunnelName}'`);
    console.log('Daemon not running — settings saved, tunnel will connect on next start.');
  }
}

export async function cloudUnlink(): Promise<void> {
  const result = await notifyDaemon('disconnectRelay');
  if (result) {
    console.log('Unlinked from relay (daemon notified).');
  } else {
    // Daemon not running — patch settings.json directly
    patchSettingsFile({
      tunnel: {
        enabled: false, relayUrl: '', pairingToken: '',
        tunnelId: '', tunnelName: '',
        enableInDevServer: true, enableInDaemon: true, enableInTauri: true,
        enableInVscode: false,
      },
    });
    // Also clean up legacy relay.json if it exists
    try { unlinkSync(relayConfigPath()); } catch { /* already gone */ }
    console.log('Unlinked from relay.');
  }
}

export async function cloudStatus(): Promise<void> {
  // Try daemon first
  const result = await notifyDaemon('getRelayConfig', {}) as {
    config?: { relayUrl: string; tunnelId: string; tunnelName: string };
    status?: string;
  } | null;
  if (result?.config) {
    console.log(`Relay:     ${result.config.relayUrl}`);
    console.log(`Name:      ${result.config.tunnelName}`);
    console.log(`Tunnel ID: ${result.config.tunnelId}`);
    console.log(`Tunnel:    ${result.status || 'unknown'}`);
    return;
  }

  // Daemon offline — read settings.json directly
  try {
    const settings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    if (settings.tunnel?.tunnelId) {
      console.log(`Relay:     ${settings.tunnel.relayUrl}`);
      console.log(`Name:      ${settings.tunnel.tunnelName}`);
      console.log(`Tunnel ID: ${settings.tunnel.tunnelId}`);
      console.log('Tunnel:    daemon not running — inactive');
      return;
    }
  } catch { /* settings missing or corrupt */ }

  // Fallback: check legacy relay.json (pre-migration)
  const config = readLegacyConfig();
  if (config) {
    console.log(`Relay:     ${config.relayUrl}`);
    console.log(`Name:      ${config.tunnelName}`);
    console.log(`Tunnel ID: ${config.tunnelId}`);
    console.log('Tunnel:    daemon not running — inactive (legacy config, will migrate on next start)');
    return;
  }

  console.log('Not linked to a relay.');
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
