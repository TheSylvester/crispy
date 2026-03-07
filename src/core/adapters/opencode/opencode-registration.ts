/**
 * OpenCode adapter registration descriptor.
 *
 * Exports everything the host's adapter-registry needs to register the
 * OpenCode adapter: discovery, factory builder, and availability check.
 *
 * @module adapters/opencode/opencode-registration
 */

import type { SessionOpenSpec, AgentAdapter } from '../../agent-adapter.js';
import type { AdapterRegistration, HostAdapterConfig } from '../../../host/adapter-registry.js';
import { OpenCodeAgentAdapter } from './opencode-agent-adapter.js';
import { opencodeDiscovery } from './opencode-discovery.js';
import { findOpencodeBinary } from '../../find-opencode-binary.js';

/** Cached binary path — resolved once at availability check time. */
let cachedBinaryPath: string | undefined;

/**
 * Build an OpenCode adapter factory that bakes in host config.
 *
 * The returned factory is called by session-manager for each new session.
 * Binary path and default cwd are captured in the closure.
 */
function createFactory(config: HostAdapterConfig): (spec: SessionOpenSpec) => AgentAdapter {
  return (spec) => {
    const effectiveCwd = ('cwd' in spec) ? spec.cwd : config.cwd;

    return new OpenCodeAgentAdapter(spec, {
      cwd: effectiveCwd,
      command: cachedBinaryPath,
    });
  };
}

/** OpenCode adapter registration descriptor. */
export const opencodeRegistration: AdapterRegistration = {
  vendor: 'opencode',
  discovery: opencodeDiscovery,
  available: (_config) => {
    cachedBinaryPath = findOpencodeBinary();
    // OpenCode is available if either the binary is installed OR the DB exists
    // (discovery can work without the binary — only live sessions need it)
    return cachedBinaryPath !== undefined;
  },
  createFactory,
};
