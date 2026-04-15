/**
 * Tunnel Config — Pure host-flag resolution for Cloud Relay tunnel
 *
 * Reads settings and returns tunnel config if the tunnel is enabled for the
 * given host type. No I/O or connection logic — just settings interpretation.
 *
 * @module tunnel-config
 */

import { getSettingsSnapshotInternal } from './settings/index.js';
import type { TunnelSettings } from './settings/types.js';

export type HostType = 'vscode' | 'dev-server' | 'daemon' | 'tauri';

/**
 * Returns tunnel config if enabled for the given host type, null otherwise.
 * Pure settings interpretation — no I/O or connection logic.
 */
export function getEnabledTunnelConfig(hostType: HostType): TunnelSettings | null {
  const { settings } = getSettingsSnapshotInternal();
  const { tunnel } = settings;
  if (!tunnel.enabled || !tunnel.tunnelId) return null;

  const hostFlag = hostType === 'dev-server' ? tunnel.enableInDevServer
    : hostType === 'daemon' ? tunnel.enableInDaemon
    : hostType === 'tauri' ? tunnel.enableInTauri
    : hostType === 'vscode' ? tunnel.enableInVscode
    : false; // unknown → deny (fail-closed)
  if (!hostFlag) return null;

  return tunnel;
}
