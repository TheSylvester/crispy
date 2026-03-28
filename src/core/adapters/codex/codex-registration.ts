/**
 * Codex adapter registration descriptor.
 *
 * Exports everything the host's adapter-registry needs to register the
 * Codex adapter: discovery, factory builder, and availability check.
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

function buildEffectiveSpec(
  spec: SessionOpenSpec,
  config: HostAdapterConfig,
  effectiveCwd: string,
): SessionOpenSpec & { cwd?: string } {
  // Prefer Codex-specific prompt (includes progressive-disclosure skill catalog)
  const hostPrompt = config.codexSystemPromptFactory?.() ?? config.systemPromptFactory?.();
  const effectiveSystemPrompt = spec.systemPrompt ?? hostPrompt;

  return {
    ...spec,
    ...(spec.mode === 'resume'
      ? (spec.cwd !== undefined ? { cwd: spec.cwd } : {})
      : { cwd: effectiveCwd }),
    ...(spec.mcpServers && Object.keys(spec.mcpServers).length > 0 ? { mcpServers: spec.mcpServers } : {}),
    ...(effectiveSystemPrompt !== undefined ? { systemPrompt: effectiveSystemPrompt } : {}),
  };
}

/**
 * Build a Codex adapter factory that bakes in host config.
 *
 * The returned factory is called by session-manager for each new session.
 * Binary path and default cwd are captured in the closure.
 */
function createFactory(config: HostAdapterConfig): (spec: SessionOpenSpec) => AgentAdapter {
  return (spec) => {
    const sessionId = spec.mode === 'resume' ? spec.sessionId
      : spec.mode === 'fork' ? spec.fromSessionId
      : undefined;
    const discoveredCwd = sessionId
      ? codexDiscovery.findSession(sessionId)?.projectPath
      : undefined;
    const effectiveCwd = ('cwd' in spec ? spec.cwd : undefined) ?? discoveredCwd ?? config.cwd;
    const effectiveSpec = buildEffectiveSpec(spec, config, effectiveCwd);

    return new CodexAgentAdapter({
      ...effectiveSpec,
      effectiveCwd,
      bundledSkillRoot: config.bundledSkillRoot,
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
