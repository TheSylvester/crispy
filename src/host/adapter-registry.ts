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
import { getSettingsSnapshotInternal, onSettingsChanged } from '../core/settings/index.js';
import { createExternalServer } from '../mcp/servers/external.js';
import type { AgentDispatch } from './agent-dispatch.js';

// Import all registration descriptors
import { claudeRegistration } from '../core/adapters/claude/claude-registration.js';
import { codexRegistration } from '../core/adapters/codex/codex-registration.js';

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
];

// ============================================================================
// Active Session Tracking
// ============================================================================

/**
 * Get the ID of the most recently active Claude session.
 *
 * Used by the external MCP server's recall tool to anchor child sessions.
 * Returns the first active Claude session's ID, or undefined if none.
 */
function getActiveClaudeSessionId(): string | undefined {
  for (const channel of getActiveChannels()) {
    if (channel.adapter?.vendor === 'claude' && channel.adapter.sessionId) {
      return channel.adapter.sessionId;
    }
  }
  return undefined;
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

  // -----------------------------------------------------------------------
  // Resolve internal MCP server paths — host-dependent.
  //
  // The recall system spawns an internal MCP server as a stdio subprocess
  // (via the child Claude Code session). The subprocess needs a command
  // and script path. These differ by host:
  //
  // VS Code extension: Source .ts files don't exist in a packaged VSIX.
  //   internal-main.ts is pre-bundled to dist/internal-mcp.js by the
  //   build:internal-mcp script. Run with `node` (no tsx needed).
  //   extensionPath is the VSIX install root, so dist/ is a sibling.
  //
  // Dev server: process.cwd() IS the project root (npm run dev runs from
  //   there), so we use tsx to run the .ts source directly for fast iteration.
  //
  // If you're seeing recall failures, check that:
  //   1. dist/internal-mcp.js exists (run `npm run build:internal-mcp`)
  //   2. extensionPath is being passed from extension.ts
  //   3. node-sqlite3-wasm is in node_modules/ (runtime dependency)
  // -----------------------------------------------------------------------
  let internalServerCommand: string;
  let internalServerArgs: string[];

  if (config.extensionPath) {
    // VS Code: pre-bundled JS, run with node
    internalServerCommand = 'node';
    internalServerArgs = [resolve(config.extensionPath, 'dist', 'internal-mcp.js')];
  } else {
    // Dev server: tsx + TypeScript source from project root
    internalServerCommand = resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
    internalServerArgs = [resolve(process.cwd(), 'src', 'mcp', 'servers', 'internal-main.ts')];
  }

  console.error(`[adapter-registry] Internal MCP server: ${internalServerCommand} ${internalServerArgs.join(' ')}`);

  // Build factory that creates fresh MCP server instances per-query.
  // Returns undefined when MCP is disabled or dispatch isn't available.
  const mcpServerFactory = dispatch
    ? (): Record<string, McpServerConfig> => {
        if (!mcpEnabled) return {};
        const server = createExternalServer(
          dispatch,
          getActiveClaudeSessionId,
          { internalServerCommand, internalServerArgs },
          () => getSettingsSnapshotInternal().settings.rosie.summarize.model,
        );
        return { crispy: server };
      }
    : undefined;

  const enrichedConfig: HostAdapterConfig = {
    ...config,
    ...(mcpServerFactory && { mcpServerFactory }),
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
