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
 * Does NOT handle MCP injection — that belongs in host-config / later sprints.
 *
 * @module host/adapter-registry
 */

import type { AgentAdapter, VendorDiscovery, SessionOpenSpec } from '../core/agent-adapter.js';
import type { Vendor } from '../core/transcript.js';
import { registerAdapter, unregisterAdapter } from '../core/session-manager.js';

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
 * config — no MCP injection, no live getters.
 */
export interface HostAdapterConfig {
  /** Default working directory for new sessions. */
  cwd: string;
  /** Explicit path to the Claude Code binary (extension passes this). */
  pathToClaudeCodeExecutable?: string;
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

  for (const reg of allRegistrations) {
    if (!reg.available(config)) {
      console.error(`[adapter-registry] ${reg.vendor} adapter skipped (not available)`);
      continue;
    }

    const factory = reg.createFactory(config);
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
