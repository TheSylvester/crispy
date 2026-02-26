/**
 * Provider Config — dynamic Anthropic-compatible provider management
 *
 * Loads/saves provider configurations from ~/.config/crispy/providers.json.
 * Each provider is a slug → config mapping that gets registered as an
 * adapter via session-manager. Claude, Codex, Gemini stay native — only
 * Anthropic-compatible third parties live in this file.
 *
 * Responsibilities:
 * - Load/save providers.json with chmod 600
 * - Build env dicts for ClaudeAgentAdapter
 * - Register/unregister dynamic adapters with session-manager
 * - Watch file for hot-reload
 * - Expose CRUD for the RPC layer
 * - Generate VendorModelGroup[] for the webview
 *
 * @module provider-config
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { ClaudeAgentAdapter, getResumeModel } from './adapters/claude/claude-code-adapter.js';
import { registerAdapter, unregisterAdapter } from './session-manager.js';
import { NATIVE_VENDORS } from './transcript.js';
import type { VendorDiscovery, SessionOpenSpec } from './agent-adapter.js';
import type { VendorModelGroup } from './provider-events.js';

// ============================================================================
// Types
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

export interface ProvidersFile {
  providers: Record<string, ProviderConfig>;
}

/** Wire-safe config — apiKey masked for webview transport. */
export interface WireProviderConfig extends Omit<ProviderConfig, 'apiKey'> {
  apiKey: string; // "sk-...xxxx" (first 3 + last 4)
}

// ============================================================================
// Constants
// ============================================================================

const CONFIG_DIR = join(homedir(), '.config', 'crispy');
const CONFIG_PATH = join(CONFIG_DIR, 'providers.json');

/** Valid provider slug: lowercase alphanumeric with hyphens, no leading/trailing hyphen. */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// ============================================================================
// Module State
// ============================================================================

/** Current in-memory providers (full configs with real API keys). */
let currentProviders: Record<string, ProviderConfig> = {};

/** Set of vendor slugs currently registered as dynamic adapters. */
const registeredDynamic = new Set<string>();

/** File watcher for hot-reload. */
let watcher: FSWatcher | null = null;

/** Debounce timer for file watcher. */
let watchDebounce: ReturnType<typeof setTimeout> | null = null;

/** Change listeners (notified on sync). */
const changeListeners = new Set<() => void>();

/** The base object (cwd + optional pathToClaudeCodeExecutable) set by syncProviders. */
let providerBase: { cwd: string; pathToClaudeCodeExecutable?: string } | null = null;

// ============================================================================
// Internal Helpers
// ============================================================================

/** Mask an API key for wire transport: first 3 + "..." + last 4. */
function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
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

/** Create an empty VendorDiscovery for a dynamic provider (sessions live in Claude's store). */
function makeDiscovery(slug: string): VendorDiscovery {
  return {
    vendor: slug,
    findSession: () => undefined,
    listSessions: () => [],
    async loadHistory() { return []; },
  };
}

/** Create an adapter factory for a dynamic provider. */
function makeFactory(
  slug: string,
  config: ProviderConfig,
  base: { cwd: string; pathToClaudeCodeExecutable?: string },
) {
  const env = buildEnvDict(config);
  return (spec: SessionOpenSpec) => {
    switch (spec.mode) {
      case 'resume': {
        const model = getResumeModel(spec.sessionId);
        return new ClaudeAgentAdapter({ ...base, resume: spec.sessionId, vendor: slug, env, ...(model && { model }) });
      }
      case 'fresh':
        return new ClaudeAgentAdapter({
          ...base, cwd: spec.cwd, vendor: slug, env,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.extraArgs && { extraArgs: spec.extraArgs }),
        });
      case 'fork':
        return new ClaudeAgentAdapter({
          ...base, resume: spec.fromSessionId, forkSession: true, vendor: slug, env,
          ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
        });
      case 'continue':
        return new ClaudeAgentAdapter({ ...base, resume: spec.sessionId, continue: true, vendor: slug, env });
      case 'hydrated':
        return new ClaudeAgentAdapter({
          ...base, cwd: spec.cwd, vendor: slug, env,
          hydratedHistory: spec.history,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
        });
    }
  };
}

// ============================================================================
// File Operations
// ============================================================================

/** Load providers from disk. On ENOENT, create default config. */
export async function loadProviders(): Promise<ProvidersFile> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as ProvidersFile;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const empty: ProvidersFile = { providers: {} };
      await saveProvidersFile(empty);
      return empty;
    }
    throw err;
  }
}

/** Write providers.json with chmod 600. Creates config dir if needed. */
export async function saveProvidersFile(data: ProvidersFile): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// ============================================================================
// Registration / Sync
// ============================================================================

/**
 * Reconcile in-memory state with providers file.
 * Registers new/enabled providers, unregisters removed/disabled ones.
 */
export async function syncProviders(
  base: { cwd: string; pathToClaudeCodeExecutable?: string },
): Promise<void> {
  providerBase = base;
  const file = await loadProviders();
  const fileProviders = file.providers;

  // Unregister removed or disabled providers
  for (const slug of registeredDynamic) {
    if (!fileProviders[slug] || !fileProviders[slug].enabled) {
      try { unregisterAdapter(slug); } catch { /* best effort */ }
      registeredDynamic.delete(slug);
    }
  }

  // Register new or re-register changed providers
  for (const [slug, config] of Object.entries(fileProviders)) {
    if (NATIVE_VENDORS.has(slug)) continue; // Never override native vendors
    if (!config.enabled) continue;

    if (registeredDynamic.has(slug)) {
      // Already registered — unregister and re-register with new config
      try { unregisterAdapter(slug); } catch { /* best effort */ }
      registeredDynamic.delete(slug);
    }

    registerAdapter(makeDiscovery(slug), makeFactory(slug, config, base));
    registeredDynamic.add(slug);
  }

  currentProviders = fileProviders;
  notifyChange();
}

// ============================================================================
// File Watching
// ============================================================================

/** Start watching providers.json for changes (200ms debounce). */
export function startWatching(
  base: { cwd: string; pathToClaudeCodeExecutable?: string },
): void {
  providerBase = base;
  if (watcher) return;

  try {
    watcher = watch(CONFIG_PATH, () => {
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        syncProviders(providerBase ?? base).catch((err) =>
          console.error('[provider-config] Watch reload failed:', err),
        );
      }, 200);
    });
  } catch {
    // File may not exist yet — that's OK, startWatching is best-effort
  }
}

/** Stop watching and clear listeners. */
export function stopWatching(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
}

// ============================================================================
// Change Notification
// ============================================================================

/** Subscribe to provider changes. Returns unsubscribe function. */
export function onProvidersChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

function notifyChange(): void {
  for (const listener of changeListeners) {
    try { listener(); } catch { /* best effort */ }
  }
}

// ============================================================================
// CRUD (for RPC layer)
// ============================================================================

/** Get all providers with masked API keys (wire-safe). */
export function getProviders(): Record<string, WireProviderConfig> {
  const result: Record<string, WireProviderConfig> = {};
  for (const [slug, config] of Object.entries(currentProviders)) {
    result[slug] = {
      ...config,
      apiKey: maskApiKey(config.apiKey),
    };
  }
  return result;
}

/** Save (create or update) a provider. Empty apiKey preserves existing key. */
export async function saveProvider(
  slug: string,
  config: ProviderConfig,
  base: { cwd: string; pathToClaudeCodeExecutable?: string },
): Promise<void> {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid provider slug: "${slug}". Must be lowercase alphanumeric with hyphens.`);
  }
  if (NATIVE_VENDORS.has(slug)) {
    throw new Error(`Cannot override native vendor "${slug}".`);
  }

  // If apiKey is empty and provider already exists, keep the existing key
  if (!config.apiKey && currentProviders[slug]) {
    config = { ...config, apiKey: currentProviders[slug].apiKey };
  }

  const file = await loadProviders();
  file.providers[slug] = config;
  await saveProvidersFile(file);
  await syncProviders(base);
}

/** Delete a provider. */
export async function deleteProvider(
  slug: string,
  base: { cwd: string; pathToClaudeCodeExecutable?: string },
): Promise<void> {
  const file = await loadProviders();
  delete file.providers[slug];
  await saveProvidersFile(file);
  await syncProviders(base);
}

/** Get the current provider base (for RPC layer). */
export function getProviderBase(): { cwd: string; pathToClaudeCodeExecutable?: string } {
  if (!providerBase) throw new Error('Provider system not initialized. Call syncProviders first.');
  return providerBase;
}

// ============================================================================
// Model Groups (for webview)
// ============================================================================

/**
 * Generate VendorModelGroup[] for the webview model dropdown.
 *
 * @param registeredVendors  Optional set of vendor slugs that have a registered
 *   adapter. When provided, groups for unregistered vendors are marked
 *   `available: false` so the UI can gray them out. When omitted (e.g. dev-server
 *   where everything is registered), all groups default to available.
 */
export function getModelGroups(registeredVendors?: Set<string>): VendorModelGroup[] {
  const groups: VendorModelGroup[] = [];

  // Claude is always first (hardcoded — native vendor)
  groups.push({
    vendor: 'claude',
    label: 'Claude',
    models: [
      { value: 'claude:opus', label: 'Opus' },
      { value: 'claude:sonnet', label: 'Sonnet' },
      { value: 'claude:haiku', label: 'Haiku' },
    ],
    available: !registeredVendors || registeredVendors.has('claude'),
  });

  // Codex — models are server-managed, user can override via model string
  groups.push({
    vendor: 'codex',
    label: 'Codex',
    models: [
      { value: 'codex:', label: 'GPT (default)' },
    ],
    available: !registeredVendors || registeredVendors.has('codex'),
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
      available: !registeredVendors || registeredVendors.has(slug),
    });
  }

  return groups;
}
