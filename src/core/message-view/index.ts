/**
 * Message View — shared layer for provider-based message rendering
 *
 * Owns provider registration, settings-driven provider instantiation, and
 * the public init/shutdown lifecycle. Platform-specific logic (Discord
 * Gateway, heartbeat, sync) lives in provider implementations.
 *
 * @module message-view/index
 */

import { log } from '../log.js';
import { onSettingsChanged, getSettingsSnapshotInternal } from '../settings/index.js';
import type { MessageProvider } from './provider.js';
import type { DiscordProviderConfig } from './config.js';
import { createDiscordProvider } from './discord-provider.js';
import type { AgentDispatch } from '../agent-dispatch-types.js';

const SOURCE = 'message-view';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

type HostType = 'vscode' | 'dev-server' | 'daemon' | 'tauri';

const providers = new Map<string, MessageProvider>();
let activeConfig: DiscordProviderConfig | null = null;
let unsubSettings: (() => void) | null = null;
let currentDispatch: AgentDispatch | null = null;
let currentCwd: string | null = null;
let currentHostType: HostType | null = null;

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

export function registerProvider(provider: MessageProvider): void {
  providers.set(provider.id, provider);
  log({ source: SOURCE, level: 'info', summary: `provider registered: ${provider.id}` });
}

export function unregisterProvider(id: string): void {
  const provider = providers.get(id);
  if (provider) {
    provider.dispose();
    providers.delete(id);
    log({ source: SOURCE, level: 'info', summary: `provider unregistered: ${id}` });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initMessageView(dispatch?: AgentDispatch, cwd?: string, hostType?: HostType): void {
  currentDispatch = dispatch ?? null;
  currentCwd = cwd ?? null;
  currentHostType = hostType ?? null;
  const config = findEnabledDiscordProvider();
  if (config) {
    startUp(config);
  } else {
    log({ source: SOURCE, level: 'info', summary: 'no enabled discord provider found -- will start when enabled' });
  }

  // Always watch settings so enabling Discord later triggers startup
  unsubSettings = onSettingsChanged(() => {
    const next = findEnabledDiscordProvider();
    if (!next) {
      if (activeConfig) tearDown();
      return;
    }
    if (activeConfig && (
      next.token !== activeConfig.token ||
      next.guildId !== activeConfig.guildId ||
      next.permissionMode !== activeConfig.permissionMode ||
      next.archivalTimeoutHours !== activeConfig.archivalTimeoutHours ||
      JSON.stringify(next.allowedUserIds) !== JSON.stringify(activeConfig.allowedUserIds)
    )) {
      tearDown();
      startUp(next);
    } else if (!activeConfig) {
      startUp(next);
    }
  });
}

export function shutdownMessageView(): void {
  if (unsubSettings) {
    unsubSettings();
    unsubSettings = null;
  }
  tearDown();
}

// ---------------------------------------------------------------------------
// Startup / Teardown
// ---------------------------------------------------------------------------

function findEnabledDiscordProvider(): DiscordProviderConfig | null {
  try {
    const { settings } = getSettingsSnapshotInternal();
    const { discord } = settings;
    if (!discord.bot.token || !discord.bot.guildId) return null;
    const hostFlag = currentHostType === 'vscode' ? discord.bot.enableInVscode
      : currentHostType === 'tauri' ? discord.bot.enableInTauri
      : currentHostType === 'daemon' ? discord.bot.enableInDaemon
      : currentHostType === 'dev-server' ? discord.bot.enableInDevServer
      : false; // unknown host type → deny (fail-closed)
    if (!hostFlag) return null;
    return {
      id: 'discord-bot',
      type: 'discord',
      token: discord.bot.token.trim(),
      guildId: discord.bot.guildId.trim(),
      permissionMode: discord.bot.permissionMode ?? settings.turnDefaults.permissionMode,
      archivalTimeoutHours: discord.bot.archivalTimeoutHours ?? 24,
      allowedUserIds: discord.bot.allowedUserIds ?? [],
    };
  } catch (err) {
    log({ source: SOURCE, level: 'warn', summary: 'failed to read Discord provider config', data: err });
    return null;
  }
}

function startUp(config: DiscordProviderConfig): void {
  if (!currentDispatch) {
    log({ source: SOURCE, level: 'warn', summary: 'cannot start provider — dispatch not initialized' });
    return;
  }
  activeConfig = config;
  const provider = createDiscordProvider(config, currentDispatch, currentCwd ?? undefined);
  registerProvider(provider);
}

function tearDown(): void {
  for (const id of providers.keys()) {
    unregisterProvider(id);
  }
  activeConfig = null;
}
