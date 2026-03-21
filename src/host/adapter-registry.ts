/**
 * Adapter Registry — centralized adapter registration for all hosts.
 *
 * Defines the AdapterRegistration descriptor type and a single
 * registerAllAdapters() function that hosts call at startup. Each
 * adapter directory exports a registration descriptor co-locating
 * its discovery, factory builder, and availability check.
 *
 * Hosts call registerAllAdapters(config) instead of manually importing
 * each adapter and duplicating per-vendor registration boilerplate.
 *
 * @module host/adapter-registry
 */

import { resolve } from 'node:path';
import type { AgentAdapter, VendorDiscovery, SessionOpenSpec, LocalPlugin } from '../core/agent-adapter.js';
import type { Vendor } from '../core/transcript.js';
import { registerAdapter, unregisterAdapter } from '../core/session-manager.js';
import { setSessionDefaults } from '../core/settings/index.js';
import type { AgentDispatch } from './agent-dispatch.js';

// Import all registration descriptors
import { claudeRegistration } from '../core/adapters/claude/claude-registration.js';
import { codexRegistration } from '../core/adapters/codex/codex-registration.js';
import { opencodeRegistration } from '../core/adapters/opencode/opencode-registration.js';

/** System prompt hint for Crispy skills — nudges the model to use /recall. */
const CRISPY_SKILLS_PROMPT =
  'You have Crispy skills available, including /recall for session transcript memory.\n\n' +
  'Proactively use /recall at the start of non-trivial tasks, before architectural ' +
  'decisions, and whenever prior context could inform your approach — not just ' +
  'when the user explicitly references past conversations.\n\n' +
  'The recall CLI (`node $RECALL_CLI`) supports two modes:\n' +
  '- Search: `node $RECALL_CLI "query"` — finds sessions by topic\n' +
  '- Read: `node $RECALL_CLI <session-id>` — reads full session content (paginated)\n' +
  'Always read into promising search results — snippets are just previews.\n\n' +
  'Your Crispy session ID is available in the $CRISPY_SESSION_ID environment variable.';

// ============================================================================
// Types
// ============================================================================

/**
 * Host-level configuration passed to adapter factory builders.
 *
 * Contains everything a factory needs to construct adapters with the
 * correct host-level settings (cwd, binary paths). Pure construction
 * config.
 */
export interface HostAdapterConfig {
  /** Default working directory for new sessions. */
  cwd: string;
  /** Explicit path to the Claude Code binary (extension passes this). */
  pathToClaudeCodeExecutable?: string;
  /** Host type — controls per-host settings like MCP server enablement. */
  hostType: 'vscode' | 'dev-server' | 'daemon';
  /** Agent dispatch for internal consumers (recall agent, Rosie). */
  dispatch?: AgentDispatch;
  /** Factory that returns the session-level system prompt (or undefined when disabled). */
  systemPromptFactory?: () => string | undefined;
  /**
   * Absolute path to the extension install directory (VS Code only).
   *
   * Used to resolve bundled CLI tools and the plugin directory.
   * Required for VS Code because process.cwd() is the user's workspace,
   * not the extension directory. Dev server doesn't need this — it uses
   * process.cwd() which IS the project root.
   *
   * Source: vscode.ExtensionContext.extensionPath in extension.ts.
   */
  extensionPath?: string;
  /** Plugins to inject into adapter sessions (set by registerAllAdapters). */
  plugins?: LocalPlugin[];
}

/**
 * Registration descriptor for a vendor adapter.
 *
 * Each adapter directory exports one of these, co-locating all
 * vendor-specific knowledge needed for registration:
 * - discovery: the VendorDiscovery for session listing/loading
 * - factory builder: creates a (spec) => AgentAdapter factory with host config baked in
 * - availability: sync check if the vendor's tooling is installed
 */
export interface AdapterRegistration {
  /** Vendor slug for identification and logging. */
  vendor: string;
  /** VendorDiscovery for stateless session operations. */
  discovery: VendorDiscovery;
  /**
   * Check if this vendor's tooling is installed and available.
   * Called once at registration time. May have side effects (e.g.,
   * caching the binary path, setting discovery command).
   * Receives host config so it can use explicit binary paths.
   */
  available: (config: HostAdapterConfig) => boolean;
  /**
   * Build a factory function for creating adapters.
   * The factory captures host config in its closure and is passed to
   * session-manager's registerAdapter(). Host-level concerns (default
   * cwd, binary paths) are baked into the returned factory.
   */
  createFactory: (config: HostAdapterConfig) => (spec: SessionOpenSpec) => AgentAdapter;
}

// ============================================================================
// All known registration descriptors
// ============================================================================

/** Ordered list of all adapter registrations. Claude first (primary vendor). */
const allRegistrations: AdapterRegistration[] = [
  claudeRegistration,
  codexRegistration,
  opencodeRegistration,
];

// ============================================================================
// Public API
// ============================================================================

/**
 * Register all available adapters with session-manager.
 *
 * Iterates known registrations, checks availability, and registers each
 * available adapter. Skipped adapters are logged to stderr (not fatal).
 *
 * Returns a dispose function that unregisters all adapters that were
 * registered. Safe to call multiple times (double-dispose is a no-op
 * since unregisterAdapter is a no-op for unregistered vendors).
 *
 * @param config - Host-level configuration for adapter factories.
 * @returns Dispose function that unregisters all registered adapters.
 */
export function registerAllAdapters(config: HostAdapterConfig): () => void {
  const registered: string[] = [];

  // Store factory deps once
  const dispatch = config.dispatch;

  // --- Plugin injection ---
  // Resolve plugin path: packaged extension uses dist/, dev uses src/
  const extBase = config.extensionPath || process.cwd();
  const pluginPath = config.extensionPath
    ? resolve(config.extensionPath, 'dist', 'crispy-plugin')
    : resolve(process.cwd(), 'src', 'plugin');
  const plugins: LocalPlugin[] = [{ type: 'local', path: pluginPath }];

  // Set env vars so skill Bash commands can find bundled CLIs
  process.env.RECALL_CLI = resolve(extBase, 'dist', 'recall.js');
  process.env.CRISPY_DISPATCH = resolve(extBase, 'dist', 'crispy-dispatch.js');
  process.env.CRISPY_TRACKER = resolve(extBase, 'dist', 'crispy-tracker.mjs');
  process.env.CRISPY_AGENT = resolve(pluginPath, 'scripts', 'crispy-agent');
  console.error(`[adapter-registry] Plugin path: ${pluginPath}`);

  // System prompt factory — skills hint (always active when dispatch is available).
  const systemPromptFactory = dispatch
    ? () => CRISPY_SKILLS_PROMPT
    : undefined;

  // Share factories with dynamic provider adapters (GLM, etc.)
  if (systemPromptFactory) {
    setSessionDefaults(systemPromptFactory, plugins);
    console.error('[adapter-registry] Session defaults registered for dynamic providers');
  }

  const enrichedConfig: HostAdapterConfig = {
    ...config,
    ...(systemPromptFactory && { systemPromptFactory }),
    plugins,
  };

  for (const reg of allRegistrations) {
    if (!reg.available(enrichedConfig)) {
      console.error(`[adapter-registry] ${reg.vendor} adapter skipped (not available)`);
      continue;
    }

    const factory = reg.createFactory(enrichedConfig);
    registerAdapter(reg.discovery, factory);
    registered.push(reg.vendor);
    console.error(`[adapter-registry] ${reg.vendor} adapter registered`);
  }

  return () => {
    for (const vendor of registered) {
      unregisterAdapter(vendor as Vendor);
    }
  };
}
