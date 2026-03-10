/**
 * Settings Types — Type definitions for the unified settings module
 *
 * All types, interfaces, and defaults for ~/.config/crispy/settings.json.
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
  | 'mcp';

// ============================================================================
// Preferences (globally persisted UI settings)
// ============================================================================

export interface SettingsPreferences {
  toolPanelAutoOpen: boolean;
  bashBlockInIcons: boolean;
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

export interface RosieSummarizeSettings {
  enabled: boolean;
  /** Model override — omit to use system default model. Format: "vendor:model" (e.g. "claude:haiku", "my-provider:glm-4.7"). */
  model?: string;
}

export interface RosieTrackerSettings {
  enabled: boolean;
  /** Model override — omit to use system default model. Format: "vendor:model" (e.g. "claude:haiku"). */
  model?: string;
}

export interface RosieSettings {
  summarize: RosieSummarizeSettings;
  tracker: RosieTrackerSettings;
}

// ============================================================================
// MCP
// ============================================================================

export interface McpMemorySettings {
  /** Enable memory MCP server on VS Code extension host. */
  vscode: boolean;
  /** Enable memory MCP server on dev-server host. */
  devServer: boolean;
}

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

/** Wire-safe snapshot — provider apiKeys masked. */
export interface WireSettingsSnapshot {
  settings: Omit<CrispySettings, 'providers'> & {
    providers: Record<string, WireProviderConfig>;
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
  rosie: { summarize?: Partial<RosieSummarizeSettings>; tracker?: Partial<RosieTrackerSettings> };
  mcp: { memory?: Partial<McpMemorySettings> };
}>;

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_SETTINGS: CrispySettings = {
  preferences: {
    toolPanelAutoOpen: true,
    bashBlockInIcons: false,
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
    summarize: { enabled: false },
    tracker: { enabled: false },
  },
  mcp: {
    memory: { vscode: true, devServer: true },
  },
};
