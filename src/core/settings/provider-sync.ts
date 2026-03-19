/**
 * Provider Sync — Adapter registration logic for dynamic providers
 *
 * Extracted from provider-config.ts. Reconciles in-memory provider
 * configurations with the adapter registry in session-manager.
 *
 * @module settings/provider-sync
 */

import { ClaudeAgentAdapter, getResumeModel, type SettingSource } from '../adapters/claude/claude-code-adapter.js';
import { registerAdapter, unregisterAdapter, getRegisteredVendors } from '../session-manager.js';
import { NATIVE_VENDORS, type Vendor } from '../transcript.js';
import type { VendorDiscovery, SessionOpenSpec, LocalPlugin } from '../agent-adapter.js';
import type { ProviderConfig } from './types.js';
import { log } from '../log.js';
import { codexDiscovery } from '../adapters/codex/codex-discovery.js';

// ============================================================================
// Types
// ============================================================================

/** Model group for a vendor — used in the webview model dropdown. */
export interface VendorModelGroup {
  vendor: Vendor;
  label: string;
  models: { value: string; label: string }[];
  /** Whether a backend adapter is registered for this vendor. Defaults to true. */
  available?: boolean;
}

// ============================================================================
// Module State
// ============================================================================

/** Set of vendor slugs currently registered as dynamic adapters. */
const registeredDynamic = new Set<string>();

/** Current providers snapshot — updated by syncProviderAdapters for getModelGroups(). */
let currentProviders: Record<string, ProviderConfig> = {};

/** System prompt factory — set by adapter-registry for dynamic providers. */
let systemPromptFactory: (() => string | undefined) | undefined;

/** Plugins — set by adapter-registry for dynamic providers. */
let sessionPlugins: LocalPlugin[] | undefined;

// ============================================================================
// Internal Helpers
// ============================================================================

/** Mask an API key for wire transport: first 3 + "..." + last 4. */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

/**
 * Set session defaults for dynamic provider adapters.
 *
 * Called by adapter-registry after creating the factories for native adapters.
 * Dynamic providers share the same system prompt and plugins as Claude.
 *
 * @param promptFactory - Factory that returns the system prompt (or undefined when disabled)
 * @param plugins - Plugins to inject into adapter sessions
 */
export function setSessionDefaults(
  promptFactory?: () => string | undefined,
  plugins?: LocalPlugin[],
): void {
  systemPromptFactory = promptFactory;
  sessionPlugins = plugins;
}

/** Build env dict from a ProviderConfig for ClaudeAgentAdapter. */
export function buildEnvDict(config: ProviderConfig): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_AUTH_TOKEN: config.apiKey,
  };

  // Map model slots to env vars
  const defaultModel = config.models.default;
  const sonnetModel = config.models.sonnet ?? defaultModel;
  const opusModel = config.models.opus ?? defaultModel;
  const haikuModel = config.models.haiku ?? defaultModel;

  // Primary model env vars (some providers require ANTHROPIC_MODEL)
  env.ANTHROPIC_MODEL = defaultModel;
  env.ANTHROPIC_SMALL_FAST_MODEL = haikuModel;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;

  if (config.timeout) env.API_TIMEOUT_MS = String(config.timeout);

  // Merge any extra env vars (e.g. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
  if (config.extraEnv) {
    Object.assign(env, config.extraEnv);
  }

  return env;
}

/**
 * Build ephemeral adapter config for Rosie child sessions.
 *
 * skipPersistSession controls single-turn behavior for summarize sessions.
 * permissionMode indicates a CLI dispatch (full agent) — don't restrict.
 */
function buildEphemeralConfig(spec: SessionOpenSpec & { skipPersistSession?: boolean; permissionMode?: string }): Record<string, unknown> {
  if (!('skipPersistSession' in spec) || !spec.skipPersistSession) return {};
  // If permissionMode is set, this is a CLI dispatch (full agent), not a
  // Rosie summarize session. Don't restrict tools or turns.
  if (spec.permissionMode) return {};
  return {
    maxTurns: 1,
    settingSources: [] as SettingSource[],
    tools: [] as string[],
  };
}

/** Create an empty VendorDiscovery for a dynamic provider (sessions live in Claude's store). */
export function makeDiscovery(slug: string): VendorDiscovery {
  return {
    vendor: slug,
    findSession: () => undefined,
    listSessions: () => [],
    async loadHistory() { return []; },
  };
}

/** Create an adapter factory for a dynamic provider. */
export function makeFactory(
  slug: string,
  config: ProviderConfig,
  base: { cwd: string; pathToClaudeCodeExecutable?: string },
) {
  const providerEnv = buildEnvDict(config);
  return (spec: SessionOpenSpec) => {
    // Build base options with MCP factories + plugins (same pattern as claude-registration.ts)
    const getBase = () => {
      const prompt = systemPromptFactory?.();
      return {
        ...(base.pathToClaudeCodeExecutable && {
          pathToClaudeCodeExecutable: base.pathToClaudeCodeExecutable,
        }),
        ...(sessionPlugins && { plugins: sessionPlugins }),
        ...(prompt && {
          systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: prompt },
        }),
      };
    };

    switch (spec.mode) {
      case 'resume': {
        const model = getResumeModel(spec.sessionId);
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: base.cwd, resume: spec.sessionId, vendor: slug, env: providerEnv, ...(model && { model })
        });
      }
      case 'fresh':
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: spec.cwd, vendor: slug,
          env: { ...providerEnv, ...(spec.env ?? {}) },
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.extraArgs && { extraArgs: spec.extraArgs }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.systemPrompt && {
            systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: spec.systemPrompt },
          }),
          ...buildEphemeralConfig(spec),
        });
      case 'fork':
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: base.cwd, resume: spec.fromSessionId, forkSession: true, vendor: slug,
          env: { ...providerEnv, ...(spec.env ?? {}) },
          ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.outputFormat && { outputFormat: spec.outputFormat }),
          ...(spec.model && { model: spec.model }),
          ...(spec.systemPrompt && {
            systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: spec.systemPrompt },
          }),
          ...(spec.outputFormat && { maxTurns: 1 }),
          ...buildEphemeralConfig(spec),
        });
      case 'hydrated':
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: spec.cwd, vendor: slug, env: providerEnv,
          hydratedHistory: spec.history,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.systemPrompt && {
            systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: spec.systemPrompt },
          }),
        });
    }
  };
}

// ============================================================================
// Sync
// ============================================================================

/**
 * Reconcile in-memory providers with adapter registry.
 * Called after every settings write that touches the providers section.
 *
 * @param providers The current providers record from settings
 * @param base Base options for adapter creation (cwd + optional pathToClaudeCodeExecutable)
 */
export function syncProviderAdapters(
  providers: Record<string, ProviderConfig>,
  base: { cwd: string; pathToClaudeCodeExecutable?: string },
): void {
  // Update cached providers for getModelGroups()
  currentProviders = providers;

  // Unregister removed or disabled providers
  for (const slug of registeredDynamic) {
    if (!providers[slug] || !providers[slug].enabled) {
      try { unregisterAdapter(slug); } catch { /* best effort */ }
      registeredDynamic.delete(slug);
      log({ source: 'provider', level: 'info', summary: `Provider: unregistered ${slug}` });
    }
  }

  // Register new or re-register changed providers
  for (const [slug, config] of Object.entries(providers)) {
    if (NATIVE_VENDORS.has(slug)) continue; // Never override native vendors
    if (!config.enabled) continue;

    if (registeredDynamic.has(slug)) {
      // Already registered — unregister and re-register with new config
      try { unregisterAdapter(slug); } catch { /* best effort */ }
      registeredDynamic.delete(slug);
    }

    registerAdapter(makeDiscovery(slug), makeFactory(slug, config, base));
    registeredDynamic.add(slug);
    log({ source: 'provider', level: 'info', summary: `Provider: registered ${slug} (${config.label})`, data: { slug, label: config.label, baseUrl: config.baseUrl } });
  }

  const activeCount = registeredDynamic.size;
  log({ source: 'provider', level: 'info', summary: `Provider: sync complete — ${activeCount} dynamic provider(s) active` });
}

// ============================================================================
// Model Groups
// ============================================================================

/**
 * Generate VendorModelGroup[] for the webview model dropdown.
 *
 * @param registeredVendors  Optional set of vendor slugs that have a registered
 *   adapter. When provided, groups for unregistered vendors are marked
 *   `available: false` so the UI can gray them out. When omitted (e.g. dev-server
 *   where everything is registered), all groups default to available.
 */
export async function getModelGroups(registeredVendors?: Set<string>): Promise<VendorModelGroup[]> {
  // Use provided set or get from session-manager
  const vendors = registeredVendors ?? getRegisteredVendors();
  const groups: VendorModelGroup[] = [];

  // Claude is always first (hardcoded — native vendor)
  groups.push({
    vendor: 'claude',
    label: 'Claude',
    models: [
      { value: '', label: 'Default' },
      { value: 'claude:opus', label: 'Opus' },
      { value: 'claude:sonnet', label: 'Sonnet' },
      { value: 'claude:haiku', label: 'Haiku' },
    ],
    available: !vendors || vendors.has('claude'),
  });

  // Codex — query live models from app-server, fall back to Default only
  const codexAvailable = !vendors || vendors.has('codex');
  let codexModels: { value: string; label: string }[] = [
    { value: 'codex:', label: 'Default' },
  ];
  if (codexAvailable) {
    try {
      const liveModels = await codexDiscovery.listModels();
      if (liveModels.length > 0) {
        codexModels = [];
        // Put the default model first
        const defaultModel = liveModels.find(m => m.isDefault);
        if (defaultModel) {
          codexModels.push({ value: 'codex:', label: `${defaultModel.displayName} (default)` });
        } else {
          codexModels.push({ value: 'codex:', label: 'Default' });
        }
        // Add non-default, non-hidden models
        for (const m of liveModels) {
          if (m.isDefault || m.hidden) continue;
          codexModels.push({ value: `codex:${m.id}`, label: m.displayName });
        }
      }
    } catch {
      // RPC failed — stick with Default only
    }
  }
  groups.push({
    vendor: 'codex',
    label: 'Codex',
    models: codexModels,
    available: codexAvailable,
  });

  // Dynamic providers
  for (const [slug, config] of Object.entries(currentProviders)) {
    if (!config.enabled) continue;

    const models: { value: string; label: string }[] = [];

    // Always include default model
    models.push({ value: `${slug}:${config.models.default}`, label: config.models.default });

    // Add opus/sonnet/haiku if they differ from default
    if (config.models.opus && config.models.opus !== config.models.default) {
      models.push({ value: `${slug}:${config.models.opus}`, label: config.models.opus });
    }
    if (config.models.sonnet && config.models.sonnet !== config.models.default) {
      models.push({ value: `${slug}:${config.models.sonnet}`, label: config.models.sonnet });
    }
    if (config.models.haiku && config.models.haiku !== config.models.default) {
      models.push({ value: `${slug}:${config.models.haiku}`, label: config.models.haiku });
    }

    groups.push({
      vendor: slug,
      label: config.label,
      models,
      available: !vendors || vendors.has(slug),
    });
  }

  return groups;
}
