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
import type { AgentAdapter, VendorDiscovery, SessionOpenSpec } from '../core/agent-adapter.js';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Vendor } from '../core/transcript.js';
import { registerAdapter, unregisterAdapter } from '../core/session-manager.js';
import { getActiveChannels } from '../core/session-channel.js';
import { getSettingsSnapshotInternal, onSettingsChanged, setMcpFactories } from '../core/settings/index.js';
import { createExternalServer } from '../mcp/servers/external.js';
import type { AgentDispatch } from './agent-dispatch.js';

// Import all registration descriptors
import { claudeRegistration } from '../core/adapters/claude/claude-registration.js';
import { codexRegistration } from '../core/adapters/codex/codex-registration.js';
import { opencodeRegistration } from '../core/adapters/opencode/opencode-registration.js';

/** System prompt injected when MCP memory is enabled — nudges the model to use recall. */
const RECALL_SYSTEM_PROMPT =
  'You have access to a conversation memory tool: mcp__memory__recall_conversations.' +
  ' Proactively use it at the start of non-trivial tasks, before architectural decisions,' +
  ' and whenever prior context could inform your approach — not just when the user explicitly' +
  ' references past conversations. Load it via ToolSearch first, then call it with a detailed' +
  ' natural-language question.';

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
  hostType: 'vscode' | 'dev-server';
  /** MCP servers to inject into adapter sessions (set by registerAllAdapters). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Factory that creates fresh MCP server instances per-query. */
  mcpServerFactory?: () => Record<string, McpServerConfig>;
  /** Agent dispatch for internal consumers (recall agent, Rosie). */
  dispatch?: AgentDispatch;
  /** Factory that returns the session-level system prompt (or undefined when disabled). */
  systemPromptFactory?: () => string | undefined;
  /**
   * Absolute path to the extension install directory (VS Code only).
   *
   * Used to resolve the bundled internal MCP server subprocess at
   * dist/internal-mcp.js. Required for VS Code because process.cwd()
   * is the user's workspace, not the extension directory. Dev server
   * doesn't need this — it uses process.cwd() which IS the project root.
   *
   * Source: vscode.ExtensionContext.extensionPath in extension.ts.
   */
  extensionPath?: string;
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
// Active Session Tracking
// ============================================================================

/**
 * Get the ID and vendor of the most recently active session.
 *
 * Used by the external MCP server's recall tool to anchor child sessions.
 * Returns the first active session's ID and vendor, or undefined if none.
 * Vendor-agnostic — works with Claude, Codex, or any future adapter.
 */
function getActiveSession(): { sessionId: string; vendor: string } | undefined {
  for (const channel of getActiveChannels()) {
    if (channel.adapter?.sessionId) {
      return { sessionId: channel.adapter.sessionId, vendor: channel.adapter.vendor };
    }
  }
  return undefined;
}

// ============================================================================
// Internal Server Path Resolution
// ============================================================================

/**
 * Resolve paths for spawning the internal MCP server subprocess.
 *
 * Used by adapter-registry (recall agent) and tracker-hook (tracker agent)
 * to spawn the same internal server. Paths differ by host:
 * - VS Code: pre-bundled dist/internal-mcp.js, run with node
 * - Dev server: TypeScript source, run with tsx
 */
export function resolveInternalServerPaths(extensionPath?: string): { command: string; args: string[] } {
  if (extensionPath) {
    return {
      command: 'node',
      args: [resolve(extensionPath, 'dist', 'internal-mcp.js')],
    };
  }
  return {
    command: resolve(process.cwd(), 'node_modules', '.bin', 'tsx'),
    args: [resolve(process.cwd(), 'src', 'mcp', 'servers', 'internal-main.ts')],
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Register all available adapters with session-manager.
 *
 * Iterates known registrations, checks availability, and registers each
 * available adapter. Skipped adapters are logged to stderr (not fatal).
 *
 * MCP servers are created per-query via a factory closure rather than as
 * a singleton. Each query() call gets a fresh McpServer instance, uses it,
 * and closes it on teardown. This avoids the SDK's "already connected"
 * error when Protocol.connect() is called on a reused instance.
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
  const settingsKey = config.hostType === 'vscode' ? 'vscode' : 'devServer';

  // Read initial MCP setting — default to true if settings not loaded yet
  let mcpEnabled = true;
  try {
    const snap = getSettingsSnapshotInternal();
    mcpEnabled = snap.settings.mcp.memory[settingsKey] ?? true;
  } catch {
    // Settings not initialized yet — use default (ON)
  }

  // Store factory deps once — the factory closure calls createExternalServer()
  // fresh each invocation so each query gets its own McpServer instance.
  const dispatch = config.dispatch;

  // Resolve internal MCP server paths — shared with tracker-hook
  const { command: internalServerCommand, args: internalServerArgs } = resolveInternalServerPaths(config.extensionPath);
  console.error(`[adapter-registry] Internal MCP server: ${internalServerCommand} ${internalServerArgs.join(' ')}`);

  // Build factory that creates fresh MCP server instances per-query.
  // Returns undefined when MCP is disabled or dispatch isn't available.
  const mcpServerFactory = dispatch
    ? (): Record<string, McpServerConfig> => {
        if (!mcpEnabled) return {};
        const server = createExternalServer(
          dispatch,
          getActiveSession,
          { internalServerCommand, internalServerArgs },
          () => getSettingsSnapshotInternal().settings.rosie.bot.model,
        );
        return { memory: server };
      }
    : undefined;

  // System prompt factory — reads mcpEnabled live (same pattern as mcpServerFactory).
  const systemPromptFactory = dispatch
    ? () => mcpEnabled ? RECALL_SYSTEM_PROMPT : undefined
    : undefined;

  // Share MCP factories with dynamic provider adapters (GLM, etc.)
  // This ensures additional providers get the same MCP tools as native Claude.
  if (mcpServerFactory || systemPromptFactory) {
    setMcpFactories(mcpServerFactory, systemPromptFactory);
    console.error('[adapter-registry] MCP factories registered for dynamic providers');
  }

  const enrichedConfig: HostAdapterConfig = {
    ...config,
    ...(mcpServerFactory && { mcpServerFactory }),
    ...(systemPromptFactory && { systemPromptFactory }),
  };

  if (mcpEnabled && mcpServerFactory) {
    console.error(`[adapter-registry] MCP external server enabled via factory (${config.hostType})`);
  }

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

  // Subscribe to settings changes — toggle mcpEnabled flag.
  // The factory checks the flag each invocation, so the toggle takes effect
  // on the next query without needing to propagate to active sessions.
  const unsubSettings = mcpServerFactory
    ? onSettingsChanged(({ snapshot, changedSections }) => {
        if (!changedSections.includes('mcp')) return;

        const newEnabled = snapshot.settings.mcp?.memory?.[settingsKey] ?? true;
        if (newEnabled === mcpEnabled) return;
        mcpEnabled = newEnabled;

        console.error(`[adapter-registry] MCP external server ${newEnabled ? 'enabled' : 'disabled'} (takes effect on next query)`);
      })
    : undefined;

  return () => {
    unsubSettings?.();
    for (const vendor of registered) {
      unregisterAdapter(vendor as Vendor);
    }
  };
}
