/**
 * Paths — Single source of truth for all Crispy persistence paths
 *
 * Pure path resolution — no I/O, no project imports (leaf module).
 * Every consumer that needs a ~/.crispy/ path imports from here.
 *
 * Platform behavior:
 * - Linux/macOS: ~/.crispy/
 * - Windows: %APPDATA%/Crispy/ (falls back to ~/AppData/Roaming/Crispy/)
 *
 * @module paths
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

// ============================================================================
// Test override
// ============================================================================

let rootOverride: string | null = null;

/**
 * Override the crispy root directory for testing.
 * Returns a cleanup function that restores the original.
 *
 * Callers must nest cleanups in LIFO order. Do not interleave with other
 * _setTestRoot callers in the same test — both _setTestDir (activity-index)
 * and _setTestConfigDir (settings-store) share this single override.
 */
export function _setTestRoot(dir: string): () => void {
  const prev = rootOverride;
  rootOverride = dir;
  return () => { rootOverride = prev; };
}

/** True when root is overridden (test mode). Used to skip legacy migrations in tests. */
export function _isTestOverride(): boolean {
  return rootOverride !== null;
}

// ============================================================================
// Path functions
// ============================================================================

/** Root persistence directory: ~/.crispy/ or %APPDATA%/Crispy/. */
export function crispyRoot(): string {
  if (rootOverride) return rootOverride;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Crispy');
  }
  return join(homedir(), '.crispy');
}

/** Path to the SQLite database. */
export function dbPath(): string {
  return join(crispyRoot(), 'crispy.db');
}

/** Path to settings.json. */
export function settingsPath(): string {
  return join(crispyRoot(), 'settings.json');
}

/**
 * Legacy config directory — always ~/.config/crispy/ regardless of platform.
 * Used only for one-time migration lookups (providers.json, settings.json).
 */
export function legacyConfigDir(): string {
  return join(homedir(), '.config', 'crispy');
}

/** IPC socket directory. */
export function ipcDir(): string {
  return join(crispyRoot(), 'ipc');
}

/** Path to the IPC servers registry file. */
export function serversFilePath(): string {
  return join(ipcDir(), 'servers.json');
}

/** Directory for downloaded embedding models. */
export function modelsDir(): string {
  return join(crispyRoot(), 'models');
}

/** Directory for downloaded binaries (llama-embedding, llama-server). */
export function binDir(): string {
  return join(crispyRoot(), 'bin');
}

/** Runtime directory for server sockets and PID files. */
export function runDir(): string {
  return join(crispyRoot(), 'run');
}

/** Daemon log directory. */
export function logsDir(): string {
  return join(crispyRoot(), 'logs');
}

/** Cache directory for Silero VAD model. */
export function vadCacheDir(): string {
  return join(crispyRoot(), 'cache', 'silero-vad');
}

/** Path to the auth token file. */
export function tokenPath(): string {
  return join(crispyRoot(), 'token');
}
