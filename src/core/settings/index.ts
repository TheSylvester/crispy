/**
 * Settings Module — Unified settings management for Crispy
 *
 * Barrel exports for the settings module. Single entry point for:
 * - Type definitions
 * - Settings store operations
 * - Provider sync utilities
 * - Event types
 *
 * @module settings
 */

// Types
export type {
  SettingsSection,
  SettingsPreferences,
  ProviderModels,
  ProviderConfig,
  WireProviderConfig,
  HookConfig,
  SettingsHooks,
  EnvPreset,
  SettingsEnvPresets,
  CliProfile,
  SettingsCliProfiles,
  SettingsTurnDefaults,
  RosieSettings,
  CrispySettings,
  CrispySettingsFile,
  SettingsSnapshot,
  WireSettingsSnapshot,
  SettingsPatch,
} from './types.js';

export { DEFAULT_SETTINGS } from './types.js';

// Events
export { SETTINGS_CHANNEL_ID } from './events.js';
export type { SettingsChangedGlobalEvent } from './events.js';

// Settings Store
export {
  initSettings,
  getSettingsSnapshot,
  getSettingsSnapshotInternal,
  updateSettings,
  deleteProvider,
  onSettingsChanged,
  startWatchingSettings,
  stopWatchingSettings,
  _setTestConfigDir,
} from './settings-store.js';

// Provider Sync
export {
  getModelGroups,
  syncProviderAdapters,
  maskApiKey,
  buildEnvDict,
  makeDiscovery,
  makeFactory,
  setSessionDefaults,
} from './provider-sync.js';

export type { VendorModelGroup } from './provider-sync.js';

// Migration
export { migrateFromProvidersJson } from './migration.js';
