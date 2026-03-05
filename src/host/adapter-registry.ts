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

import type { AgentAdapter, VendorDiscovery, SessionOpenSpec } from '../core/agent-adapter.js';
import type { McpServerConfig, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Vendor } from '../core/transcript.js';
import { registerAdapter, unregisterAdapter } from '../core/session-manager.js';
import { getActiveChannels } from '../core/session-channel.js';
import { getSettingsSnapshotInternal, onSettingsChanged } from '../core/settings/index.js';
import { createExternalServer } from '../mcp/servers/external.js';
import { ClaudeAgentAdapter } from '../core/adapters/claude/claude-code-adapter.js';
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
  /** Agent dispatch for internal consumers (recall agent, Rosie). */
  dispatch?: AgentDispatch;
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
    if (channel.adapter instanceof ClaudeAgentAdapter && channel.adapter.sessionId) {
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

  // Create the external MCP server (recall tool) if dispatch is available.
  // Always created — we toggle inclusion at the adapter level based on settings.
  let externalServer: McpSdkServerConfigWithInstance | undefined;
  if (config.dispatch) {
    try {
      externalServer = createExternalServer(config.dispatch, getActiveClaudeSessionId);
    } catch (err) {
      console.error('[adapter-registry] Failed to create external MCP server:', err);
    }
  }

  // Read initial MCP setting — default to true if settings not loaded yet
  let mcpEnabled = true;
  try {
    const snap = getSettingsSnapshotInternal();
    mcpEnabled = snap.settings.mcp.memory[settingsKey] ?? true;
  } catch {
    // Settings not initialized yet — use default (ON)
  }

  const enrichedConfig = { ...config };
  if (mcpEnabled && externalServer) {
    enrichedConfig.mcpServers = { crispy: externalServer };
    console.error(`[adapter-registry] MCP external server enabled (${config.hostType})`);
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

  // Subscribe to settings changes — toggle MCP on active Claude sessions
  const unsubSettings = externalServer
    ? onSettingsChanged(({ snapshot, changedSections }) => {
        if (!changedSections.includes('mcp')) return;

        const newEnabled = snapshot.settings.mcp?.memory?.[settingsKey] ?? true;
        if (newEnabled === mcpEnabled) return;
        mcpEnabled = newEnabled;

        // Update config so new sessions pick up the toggle via getBase()
        enrichedConfig.mcpServers = newEnabled ? { crispy: externalServer! } : undefined;

        const newServers: Record<string, McpServerConfig> = newEnabled
          ? { crispy: externalServer! }
          : {};

        // Propagate to all active Claude sessions
        for (const channel of getActiveChannels()) {
          if (channel.adapter instanceof ClaudeAgentAdapter) {
            channel.adapter.setMcpServers(newServers).catch((err) => {
              console.error('[adapter-registry] Failed to update MCP servers on live session:', err);
            });
          }
        }

        console.error(`[adapter-registry] MCP external server ${newEnabled ? 'enabled' : 'disabled'} (live update)`);
      })
    : undefined;

  return () => {
    unsubSettings?.();
    for (const vendor of registered) {
      unregisterAdapter(vendor as Vendor);
    }
  };
}
