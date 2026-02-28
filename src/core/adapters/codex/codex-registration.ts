/**
 * Codex adapter registration descriptor.
 *
 * Exports everything the host's adapter-registry needs to register the
 * Codex adapter: discovery, factory builder, and availability check.
 *
 * Pure adapter construction — no MCP injection. MCP concerns are handled
 * by host-config and later sprints.
 *
 * @module adapters/codex/codex-registration
 */

import type { SessionOpenSpec, AgentAdapter } from '../../agent-adapter.js';
import type { AdapterRegistration, HostAdapterConfig } from '../../../host/adapter-registry.js';
import { CodexAgentAdapter } from './codex-app-server-adapter.js';
import { codexDiscovery } from './codex-discovery.js';
import { findCodexBinary } from '../../find-codex-binary.js';

/** Cached binary path — resolved once at availability check time. */
let cachedBinaryPath: string | undefined;

/**
 * Build a Codex adapter factory that bakes in host config.
 *
 * The returned factory is called by session-manager for each new session.
 * Binary path and default cwd are captured in the closure.
 */
function createFactory(config: HostAdapterConfig): (spec: SessionOpenSpec) => AgentAdapter {
  return (spec) => {
    const effectiveCwd = ('cwd' in spec) ? spec.cwd : config.cwd;

    return new CodexAgentAdapter({
      ...spec,
      cwd: effectiveCwd,
      command: cachedBinaryPath,
      args: ['app-server'],
    });
  };
}

/** Codex adapter registration descriptor. */
export const codexRegistration: AdapterRegistration = {
  vendor: 'codex',
  discovery: codexDiscovery,
  available: (_config) => {
    cachedBinaryPath = findCodexBinary();
    if (cachedBinaryPath) {
      codexDiscovery.setCommand(cachedBinaryPath);
    }
    return cachedBinaryPath !== undefined;
  },
  createFactory,
};
