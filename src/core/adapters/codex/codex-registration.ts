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

function resolveCallerSessionId(spec: SessionOpenSpec): string {
  switch (spec.mode) {
    case 'resume':
      return spec.sessionId;
    case 'fork':
      return spec.fromSessionId;
    case 'hydrated':
      return spec.sourceSessionId ?? '';
    case 'fresh':
      return '';
  }
}

function mergeMcpServers(
  hostDefaults: Record<string, unknown> | undefined,
  explicit: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!hostDefaults && !explicit) return undefined;
  return {
    ...(hostDefaults ?? {}),
    ...(explicit ?? {}),
  };
}

function buildEffectiveSpec(
  spec: SessionOpenSpec,
  config: HostAdapterConfig,
  effectiveCwd: string,
): SessionOpenSpec & { cwd?: string } {
  const callerSessionId = resolveCallerSessionId(spec);
  const hostPrompt = config.systemPromptFactory?.();
  const hostMcpServers = config.mcpServerFactory?.(callerSessionId, 'codex') as Record<string, unknown> | undefined;
  const mergedMcpServers = mergeMcpServers(hostMcpServers, spec.mcpServers);
  const effectiveSystemPrompt = spec.systemPrompt ?? hostPrompt;

  return {
    ...spec,
    ...(spec.mode === 'resume'
      ? (spec.cwd !== undefined ? { cwd: spec.cwd } : {})
      : { cwd: effectiveCwd }),
    ...(mergedMcpServers && Object.keys(mergedMcpServers).length > 0 ? { mcpServers: mergedMcpServers } : {}),
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
    const effectiveCwd = ('cwd' in spec ? spec.cwd : undefined) ?? config.cwd;
    const effectiveSpec = buildEffectiveSpec(spec, config, effectiveCwd);

    return new CodexAgentAdapter({
      ...effectiveSpec,
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
