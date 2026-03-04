/**
 * Settings Store — Load/save/watch/notify/CRUD for settings.json
 *
 * Main module for the unified settings system. Handles:
 * - File I/O with chmod 600 permissions
 * - Migration from legacy providers.json
 * - Optimistic concurrency via revision counter
 * - FSWatcher for external changes
 * - Change notification to subscribers
 * - Provider adapter sync on provider changes
 *
 * @module settings/settings-store
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type {
  CrispySettings,
  CrispySettingsFile,
  SettingsSnapshot,
  WireSettingsSnapshot,
  SettingsPatch,
  SettingsSection,
  ProviderConfig,
  WireProviderConfig,
} from './types.js';
import { DEFAULT_SETTINGS } from './types.js';
import { migrateFromProvidersJson } from './migration.js';
import { syncProviderAdapters, maskApiKey } from './provider-sync.js';
import { NATIVE_VENDORS } from '../transcript.js';

// ============================================================================
// Constants
// ============================================================================

/** Valid provider slug: lowercase alphanumeric with hyphens, no leading/trailing hyphen. */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Default config directory. */
const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'crispy');

// ============================================================================
// Module State
// ============================================================================

/** Current in-memory settings (full, with real API keys). */
let currentSettings: CrispySettingsFile = {
  version: 1,
  revision: 0,
  updatedAt: new Date().toISOString(),
  ...DEFAULT_SETTINGS,
};

/** File watcher for hot-reload. */
let watcher: FSWatcher | null = null;

/** Debounce timer for file watcher. */
let watchDebounce: ReturnType<typeof setTimeout> | null = null;

/** Change listeners (notified on sync). */
const changeListeners = new Set<(evt: {
  snapshot: WireSettingsSnapshot;
  changedSections: SettingsSection[];
  source: 'rpc' | 'watch' | 'migration';
}) => void>();

/** Config directory path (overridable for tests). */
let configDir = DEFAULT_CONFIG_DIR;

/** Full path to settings.json. */
let settingsPath = join(configDir, 'settings.json');

/** Base options for adapter creation. */
let providerBase: { cwd: string; pathToClaudeCodeExecutable?: string } | null = null;

// ============================================================================
// Helpers
// ============================================================================

/** Mask all provider API keys for wire transport. */
function maskProviders(
  providers: Record<string, ProviderConfig>,
): Record<string, WireProviderConfig> {
  const result: Record<string, WireProviderConfig> = {};
  for (const [slug, config] of Object.entries(providers)) {
    result[slug] = {
      ...config,
      apiKey: maskApiKey(config.apiKey),
    };
  }
  return result;
}

/** Convert internal snapshot to wire-safe snapshot. */
function toWireSnapshot(settings: CrispySettingsFile): WireSettingsSnapshot {
  return {
    settings: {
      ...settings,
      providers: maskProviders(settings.providers),
    },
    revision: settings.revision,
    updatedAt: settings.updatedAt,
  };
}

/** Compute which sections changed between old and new settings. */
function computeChangedSections(
  oldSettings: CrispySettings,
  newSettings: CrispySettings,
): SettingsSection[] {
  const sections: SettingsSection[] = [
    'preferences',
    'providers',
    'hooks',
    'envPresets',
    'cliProfiles',
    'turnDefaults',
    'rosie',
  ];

  return sections.filter(
    (section) =>
      JSON.stringify(oldSettings[section]) !== JSON.stringify(newSettings[section]),
  );
}

/** Deep merge patch into settings. Arrays are replaced, not appended. */
function applyPatch(current: CrispySettings, patch: SettingsPatch): CrispySettings {
  const result: CrispySettings = { ...current };

  if (patch.preferences) {
    result.preferences = { ...current.preferences, ...patch.preferences };
  }

  if (patch.providers) {
    // Merge providers: existing + patched
    result.providers = { ...current.providers };
    for (const [slug, config] of Object.entries(patch.providers)) {
      // Empty apiKey preserves existing key
      if (!config.apiKey && result.providers[slug]) {
        result.providers[slug] = { ...config, apiKey: result.providers[slug].apiKey };
      } else {
        result.providers[slug] = config;
      }
    }
  }

  if (patch.hooks) {
    result.hooks = { ...current.hooks, ...patch.hooks };
  }

  if (patch.envPresets) {
    result.envPresets = { ...current.envPresets, ...patch.envPresets };
  }

  if (patch.cliProfiles) {
    result.cliProfiles = { ...current.cliProfiles, ...patch.cliProfiles };
  }

  if (patch.turnDefaults) {
    result.turnDefaults = { ...current.turnDefaults, ...patch.turnDefaults };
  }

  if (patch.rosie) {
    result.rosie = { ...current.rosie, ...patch.rosie };
  }

  return result;
}

/** Validate settings structure, sanitize invalid fields. */
function sanitizeSettings(data: unknown): CrispySettings {
  if (!data || typeof data !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }

  const settings = data as Record<string, unknown>;
  const result: CrispySettings = { ...DEFAULT_SETTINGS };

  // Preferences
  if (settings.preferences && typeof settings.preferences === 'object') {
    const prefs = settings.preferences as Record<string, unknown>;
    if (typeof prefs.toolPanelAutoOpen === 'boolean') {
      result.preferences.toolPanelAutoOpen = prefs.toolPanelAutoOpen;
    }
  }

  // Providers
  if (settings.providers && typeof settings.providers === 'object') {
    result.providers = settings.providers as Record<string, ProviderConfig>;
  }

  // Hooks
  if (settings.hooks && typeof settings.hooks === 'object') {
    result.hooks = settings.hooks as typeof result.hooks;
  }

  // Env Presets
  if (settings.envPresets && typeof settings.envPresets === 'object') {
    result.envPresets = settings.envPresets as typeof result.envPresets;
  }

  // CLI Profiles
  if (settings.cliProfiles && typeof settings.cliProfiles === 'object') {
    result.cliProfiles = settings.cliProfiles as typeof result.cliProfiles;
  }

  // Turn Defaults
  if (settings.turnDefaults && typeof settings.turnDefaults === 'object') {
    result.turnDefaults = settings.turnDefaults as typeof result.turnDefaults;
  }

  // Rosie Bot
  if (settings.rosie && typeof settings.rosie === 'object') {
    const rosie = settings.rosie as Record<string, unknown>;
    if (typeof rosie.enabled === 'boolean') {
      result.rosie = { enabled: rosie.enabled };
      if (typeof rosie.model === 'string' && rosie.model.trim()) {
        result.rosie.model = rosie.model.trim();
      }
    }
  }

  return result;
}

// ============================================================================
// File Operations
// ============================================================================

/** Load settings from disk. Creates defaults if missing. */
async function loadSettingsFile(): Promise<CrispySettingsFile> {
  try {
    const raw = await readFile(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as CrispySettingsFile;

    // Validate version
    if (parsed.version !== 1) {
      console.warn('[settings-store] Unknown settings version, using defaults');
      return {
        version: 1,
        revision: 0,
        updatedAt: new Date().toISOString(),
        ...DEFAULT_SETTINGS,
      };
    }

    // Sanitize and return
    const sanitized = sanitizeSettings(parsed);
    return {
      version: 1,
      revision: parsed.revision ?? 0,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      ...sanitized,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist — will be created on first write
      return {
        version: 1,
        revision: 0,
        updatedAt: new Date().toISOString(),
        ...DEFAULT_SETTINGS,
      };
    }

    // Corrupt JSON — rename and start fresh
    if (err instanceof SyntaxError) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptPath = join(configDir, `settings.json.corrupt.${timestamp}`);
      try {
        await rename(settingsPath, corruptPath);
        console.error(`[settings-store] Corrupt settings.json renamed to ${corruptPath}`);
      } catch {
        // Best-effort rename
      }
      return {
        version: 1,
        revision: 0,
        updatedAt: new Date().toISOString(),
        ...DEFAULT_SETTINGS,
      };
    }

    throw err;
  }
}

/** Write settings to disk with chmod 600. */
async function saveSettingsFile(settings: CrispySettingsFile): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const content = JSON.stringify(settings, null, 2) + '\n';
  await writeFile(settingsPath, content, { mode: 0o600 });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the settings store.
 *
 * Loads settings from disk, runs migration if needed, and syncs provider adapters.
 */
export async function initSettings(
  base: { cwd: string; pathToClaudeCodeExecutable?: string },
): Promise<void> {
  providerBase = base;

  // Load existing settings
  let settings = await loadSettingsFile();

  // Check if this is first boot (revision 0 and no providers)
  const needsMigration =
    settings.revision === 0 &&
    Object.keys(settings.providers).length === 0;

  if (needsMigration) {
    // Migrate from legacy providers.json
    const migratedProviders = await migrateFromProvidersJson(configDir);
    if (Object.keys(migratedProviders).length > 0) {
      settings = {
        ...settings,
        providers: migratedProviders,
        revision: 1,
        updatedAt: new Date().toISOString(),
      };
      await saveSettingsFile(settings);

      // Notify listeners of migration
      const wireSnapshot = toWireSnapshot(settings);
      for (const listener of changeListeners) {
        try {
          listener({
            snapshot: wireSnapshot,
            changedSections: ['providers'],
            source: 'migration',
          });
        } catch { /* best effort */ }
      }
    }
  }

  currentSettings = settings;

  // Sync provider adapters
  syncProviderAdapters(settings.providers, base);
}

/** Returns wire-safe snapshot (masked API keys). */
export function getSettingsSnapshot(): WireSettingsSnapshot {
  return toWireSnapshot(currentSettings);
}

/** Internal: returns full snapshot with real API keys. For adapter sync only. */
export function getSettingsSnapshotInternal(): SettingsSnapshot {
  return {
    settings: {
      preferences: currentSettings.preferences,
      providers: currentSettings.providers,
      hooks: currentSettings.hooks,
      envPresets: currentSettings.envPresets,
      cliProfiles: currentSettings.cliProfiles,
      turnDefaults: currentSettings.turnDefaults,
      rosie: currentSettings.rosie,
    },
    revision: currentSettings.revision,
    updatedAt: currentSettings.updatedAt,
  };
}

/**
 * Update settings with a partial patch.
 *
 * @param patch Partial settings to merge
 * @param opts.expectedRevision For optimistic concurrency — if stale, throws SETTINGS_CONFLICT
 * @returns Updated wire-safe snapshot
 */
export async function updateSettings(
  patch: SettingsPatch,
  opts?: { expectedRevision?: number },
): Promise<WireSettingsSnapshot> {
  // Check optimistic concurrency
  if (opts?.expectedRevision !== undefined && opts.expectedRevision !== currentSettings.revision) {
    const error = new Error('SETTINGS_CONFLICT') as Error & { snapshot: WireSettingsSnapshot };
    error.snapshot = toWireSnapshot(currentSettings);
    throw error;
  }

  // Validate provider slugs
  if (patch.providers) {
    for (const slug of Object.keys(patch.providers)) {
      if (!SLUG_RE.test(slug)) {
        throw new Error(`Invalid provider slug: "${slug}". Must be lowercase alphanumeric with hyphens.`);
      }
      if (NATIVE_VENDORS.has(slug)) {
        throw new Error(`Cannot override native vendor "${slug}".`);
      }
    }
  }

  const oldSettings = { ...currentSettings };
  const newSettings = applyPatch(currentSettings, patch);
  const changedSections = computeChangedSections(oldSettings, newSettings);

  // Update in-memory state
  currentSettings = {
    ...newSettings,
    version: 1,
    revision: currentSettings.revision + 1,
    updatedAt: new Date().toISOString(),
  };

  // Persist to disk
  await saveSettingsFile(currentSettings);

  // Sync provider adapters if providers changed
  if (changedSections.includes('providers') && providerBase) {
    syncProviderAdapters(currentSettings.providers, providerBase);
  }

  // Notify listeners
  const wireSnapshot = toWireSnapshot(currentSettings);
  for (const listener of changeListeners) {
    try {
      listener({ snapshot: wireSnapshot, changedSections, source: 'rpc' });
    } catch { /* best effort */ }
  }

  return wireSnapshot;
}

/**
 * Delete a provider by slug.
 *
 * Convenience wrapper over updateSettings — removes the provider from the record.
 */
export async function deleteProvider(
  slug: string,
  opts?: { expectedRevision?: number },
): Promise<WireSettingsSnapshot> {
  // Check optimistic concurrency
  if (opts?.expectedRevision !== undefined && opts.expectedRevision !== currentSettings.revision) {
    const error = new Error('SETTINGS_CONFLICT') as Error & { snapshot: WireSettingsSnapshot };
    error.snapshot = toWireSnapshot(currentSettings);
    throw error;
  }

  if (!currentSettings.providers[slug]) {
    // Provider doesn't exist — return current state
    return toWireSnapshot(currentSettings);
  }

  const oldSettings = { ...currentSettings };

  // Remove the provider
  const newProviders = { ...currentSettings.providers };
  delete newProviders[slug];

  currentSettings = {
    ...currentSettings,
    version: 1,
    revision: currentSettings.revision + 1,
    updatedAt: new Date().toISOString(),
    providers: newProviders,
  };

  // Persist to disk
  await saveSettingsFile(currentSettings);

  // Sync provider adapters
  if (providerBase) {
    syncProviderAdapters(currentSettings.providers, providerBase);
  }

  // Notify listeners
  const wireSnapshot = toWireSnapshot(currentSettings);
  const changedSections = computeChangedSections(oldSettings, currentSettings);
  for (const listener of changeListeners) {
    try {
      listener({ snapshot: wireSnapshot, changedSections, source: 'rpc' });
    } catch { /* best effort */ }
  }

  return wireSnapshot;
}

/**
 * Subscribe to settings changes.
 *
 * @returns Unsubscribe function
 */
export function onSettingsChanged(
  listener: (evt: {
    snapshot: WireSettingsSnapshot;
    changedSections: SettingsSection[];
    source: 'rpc' | 'watch' | 'migration';
  }) => void,
): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** Start watching settings.json for changes (200ms debounce). */
export function startWatchingSettings(): void {
  if (watcher) return;

  try {
    watcher = watch(settingsPath, () => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(async () => {
        try {
          const oldSettings = { ...currentSettings };
          const newSettings = await loadSettingsFile();

          // Skip if revision hasn't changed (our own write)
          if (newSettings.revision === currentSettings.revision) {
            return;
          }

          const changedSections = computeChangedSections(oldSettings, newSettings);
          currentSettings = newSettings;

          // Sync provider adapters if providers changed
          if (changedSections.includes('providers') && providerBase) {
            syncProviderAdapters(currentSettings.providers, providerBase);
          }

          // Notify listeners
          const wireSnapshot = toWireSnapshot(currentSettings);
          for (const listener of changeListeners) {
            try {
              listener({ snapshot: wireSnapshot, changedSections, source: 'watch' });
            } catch { /* best effort */ }
          }
        } catch (err) {
          console.error('[settings-store] Watch reload failed:', err);
        }
      }, 200);
    });
  } catch {
    // File may not exist yet — that's OK, startWatchingSettings is best-effort
  }
}

/** Stop watching and clear listeners. */
export function stopWatchingSettings(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
}

/**
 * Override the config directory for tests.
 *
 * @returns Cleanup function that restores the original directory
 */
export function _setTestConfigDir(dir: string): () => void {
  const originalConfigDir = configDir;
  const originalSettingsPath = settingsPath;
  const originalProviderBase = providerBase;

  configDir = dir;
  settingsPath = join(dir, 'settings.json');

  // Reset state
  currentSettings = {
    version: 1,
    revision: 0,
    updatedAt: new Date().toISOString(),
    ...DEFAULT_SETTINGS,
  };
  changeListeners.clear();
  providerBase = null;

  return () => {
    configDir = originalConfigDir;
    settingsPath = originalSettingsPath;
    providerBase = originalProviderBase;
    currentSettings = {
      version: 1,
      revision: 0,
      updatedAt: new Date().toISOString(),
      ...DEFAULT_SETTINGS,
    };
    changeListeners.clear();
  };
}
