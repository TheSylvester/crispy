/**
 * Settings Types — Type definitions for the unified settings module
 *
 * All types, interfaces, and defaults for settings.json (see paths.ts for location).
 * Vendor-agnostic — no imports from adapter-specific modules.
 *
 * @module settings/types
 */

// ============================================================================
// Section Keys
// ============================================================================

export type SettingsSection =
  | 'preferences'
  | 'providers'
  | 'hooks'
  | 'envPresets'
  | 'cliProfiles'
  | 'turnDefaults'
  | 'rosie'
  | 'discord'
  | 'mcp';

// ============================================================================
// Preferences (globally persisted UI settings)
// ============================================================================

export interface SettingsPreferences {
  toolPanelAutoOpen: boolean;
  bashBlockInIcons: boolean;
  renderMode: string;
  badgeStyle: string;
  /** Display style for assistant markdown rendering. Default: 'crispy'. */
  displayStyle: string;
  /** Auto-invoke /reflect after creating implementation plans. Default: true. */
  autoReflect: boolean;
  /** Which side the Git border panel docks to. Default: 'left'. */
  gitPanelSide: 'left' | 'right';
  /** Use the display style accent color instead of permission-mode colors. */
  useDisplayStyleAccent: boolean;
}

// ============================================================================
// Providers (migrated from provider-config.ts)
// ============================================================================

export interface ProviderModels {
  default: string;
  opus?: string;
  sonnet?: string;
  haiku?: string;
}

export interface ProviderConfig {
  label: string;
  baseUrl: string;
  apiKey: string;
  models: ProviderModels;
  timeout?: number;
  /** Extra env vars passed to the adapter (e.g. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC). */
  extraEnv?: Record<string, string>;
  enabled: boolean;
}

/** Wire-safe — apiKey masked for transport. */
export interface WireProviderConfig extends Omit<ProviderConfig, 'apiKey'> {
  apiKey: string; // "sk-...xxxx"
}

// ============================================================================
// Hooks
// ============================================================================

export interface HookConfig {
  id: string;
  enabled: boolean;
  command: string;
  timeoutMs: number;
  envPresetId: string | null;
}

export interface SettingsHooks {
  prePromptSend: HookConfig[];
  postTurnComplete: HookConfig[];
}

// ============================================================================
// Rosie Bot
// ============================================================================

export interface RosieBotSettings {
  enabled: boolean;
  /** Model override. Format: "vendor:model" (e.g. "claude:haiku"). */
  model?: string;
}

export interface RosieSettings {
  bot: RosieBotSettings;
}

// ============================================================================
// Discord Bot
// ============================================================================

export interface DiscordBotSettings {
  enabled: boolean;
  token: string;
  guildId: string;
  /** Override permission mode for Discord sessions. null = use turnDefaults. */
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | null;
  /** Hours of inactivity before auto-archiving a Discord thread. Default: 24. */
  archivalTimeoutHours: number;
  /** Numeric Discord user IDs allowed to interact. Empty = owner-only (resolved via OAuth). */
  allowedUserIds: string[];
  /** Connect the Discord bot when running as a VS Code extension. Default: true. */
  enableInVscode: boolean;
  /** Connect the Discord bot when running as a dev server. Default: true. */
  enableInDevServer: boolean;
  /** Connect the Discord bot when running as a standalone daemon (`crispy start`). Default: true. */
  enableInDaemon: boolean;
  /** Connect the Discord bot when running as the Tauri desktop app. Default: true. */
  enableInTauri: boolean;
}

export interface DiscordSettings {
  bot: DiscordBotSettings;
}

// ============================================================================
// MCP
// ============================================================================

/** @deprecated MCP servers replaced by plugin bundle. Kept for settings file compat. */
export interface McpMemorySettings {
  /** Enable memory MCP server on VS Code extension host. */
  vscode: boolean;
  /** Enable memory MCP server on dev-server host. */
  devServer: boolean;
}

/** @deprecated MCP servers replaced by plugin bundle. Kept for settings file compat. */
export interface McpSettings {
  memory: McpMemorySettings;
}

// ============================================================================
// Env Presets
// ============================================================================

export interface EnvPreset {
  label: string;
  vars: Record<string, string>;
}

export interface SettingsEnvPresets {
  activePresetId: string | null;
  presets: Record<string, EnvPreset>;
}

// ============================================================================
// CLI Profiles
// ============================================================================

export interface CliProfile {
  label: string;
  vendor: 'claude' | 'codex' | 'gemini';
  args: string[];
}

export interface SettingsCliProfiles {
  defaultProfileByVendor: {
    claude: string | null;
    codex: string | null;
    gemini: string | null;
  };
  profiles: Record<string, CliProfile>;
}

// ============================================================================
// Turn Defaults
// ============================================================================

export interface SettingsTurnDefaults {
  model: string | null;
  permissionMode: string | null;
  allowDangerouslySkipPermissions: boolean;
  extraArgs: Record<string, string | null>;
  // Chrome: { chrome: null } enables --chrome flag
}

// ============================================================================
// Root Settings
// ============================================================================

export interface CrispySettings {
  preferences: SettingsPreferences;
  providers: Record<string, ProviderConfig>;
  hooks: SettingsHooks;
  envPresets: SettingsEnvPresets;
  cliProfiles: SettingsCliProfiles;
  turnDefaults: SettingsTurnDefaults;
  rosie: RosieSettings;
  discord: DiscordSettings;
  mcp: McpSettings;
}

export interface CrispySettingsFile extends CrispySettings {
  version: 1;
  revision: number;
  updatedAt: string;
}

export interface SettingsSnapshot {
  settings: CrispySettings;
  revision: number;
  updatedAt: string;
}

/** Wire-safe snapshot — provider apiKeys and discord bot token masked. */
export interface WireSettingsSnapshot {
  settings: Omit<CrispySettings, 'providers' | 'discord'> & {
    providers: Record<string, WireProviderConfig>;
    discord: { bot: Omit<DiscordBotSettings, 'token'> & { token: string } };
  };
  revision: number;
  updatedAt: string;
}

export type SettingsPatch = Partial<{
  preferences: Partial<SettingsPreferences>;
  providers: Record<string, ProviderConfig>; // full replacement per slug
  hooks: Partial<SettingsHooks>;
  envPresets: Partial<SettingsEnvPresets>;
  cliProfiles: Partial<SettingsCliProfiles>;
  turnDefaults: Partial<SettingsTurnDefaults>;
  rosie: { bot?: Partial<RosieBotSettings> };
  discord: { bot?: Partial<DiscordBotSettings> };
  mcp: { memory?: Partial<McpMemorySettings> };
}>;

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_SETTINGS: CrispySettings = {
  preferences: {
    toolPanelAutoOpen: false,
    bashBlockInIcons: true,
    renderMode: 'icons',
    badgeStyle: 'frosted',
    displayStyle: 'crispy',
    autoReflect: true,
    gitPanelSide: 'left',
    useDisplayStyleAccent: true,
  },
  providers: {},
  hooks: {
    prePromptSend: [],
    postTurnComplete: [],
  },
  envPresets: {
    activePresetId: null,
    presets: {},
  },
  cliProfiles: {
    defaultProfileByVendor: { claude: null, codex: null, gemini: null },
    profiles: {},
  },
  turnDefaults: {
    model: null,
    permissionMode: null,
    allowDangerouslySkipPermissions: false,
    extraArgs: {},
  },
  rosie: {
    bot: { enabled: false },
  },
  discord: {
    bot: { enabled: false, token: '', guildId: '', permissionMode: null, archivalTimeoutHours: 24, allowedUserIds: [], enableInVscode: true, enableInDevServer: true, enableInDaemon: true, enableInTauri: true },
  },
  mcp: {
    memory: { vscode: true, devServer: true },
  },
};
