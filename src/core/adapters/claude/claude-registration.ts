/**
 * Claude adapter registration descriptor.
 *
 * Exports everything the host's adapter-registry needs to register the
 * Claude adapter: discovery, factory builder, and availability check.
 *
 * @module adapters/claude/claude-registration
 */

import type { SessionOpenSpec, AgentAdapter } from '../../agent-adapter.js';
import type { AdapterRegistration, HostAdapterConfig } from '../../../host/adapter-registry.js';
import { ClaudeAgentAdapter, claudeDiscovery, getResumeModel, type SettingSource } from './claude-code-adapter.js';
import { findClaudeBinary } from '../../find-claude-binary.js';

/** Cached binary path — resolved once at availability check time. */
let cachedBinaryPath: string | undefined;

/**
 * Build a Claude adapter factory that bakes in host config.
 *
 * The returned factory is called by session-manager for each new session.
 * Host-level concerns (cwd default, binary path) are captured in the
 * closure — session-manager stays vendor-agnostic.
 */
function createFactory(config: HostAdapterConfig): (spec: SessionOpenSpec) => AgentAdapter {
  const base = {
    ...(config.pathToClaudeCodeExecutable && {
      pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
    }),
  };

  return (spec) => {
    switch (spec.mode) {
      case 'resume': {
        const model = getResumeModel(spec.sessionId);
        return new ClaudeAgentAdapter({
          ...base, cwd: config.cwd, resume: spec.sessionId,
          ...(model && { model }),
        });
      }
      case 'fresh':
        return new ClaudeAgentAdapter({
          ...base, cwd: spec.cwd,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.extraArgs && { extraArgs: spec.extraArgs }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.maxTurns !== undefined && { maxTurns: spec.maxTurns }),
          ...(spec.settingSources && { settingSources: spec.settingSources as SettingSource[] }),
          ...(spec.disableTools && { tools: [] }),
        });
      case 'fork':
        return new ClaudeAgentAdapter({
          ...base, cwd: config.cwd, resume: spec.fromSessionId, forkSession: true,
          ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.outputFormat && { outputFormat: spec.outputFormat }),
          ...(spec.model && { model: spec.model }),
          // Structured output forks should complete in a single model response.
          ...(spec.outputFormat && { maxTurns: 1 }),
          // Explicit session-open overrides (e.g., Rosie child sessions) —
          // applied last so they take precedence over outputFormat defaults.
          ...(spec.maxTurns !== undefined && { maxTurns: spec.maxTurns }),
          ...(spec.settingSources && { settingSources: spec.settingSources as SettingSource[] }),
          ...(spec.disableTools && { tools: [] }),
        });
      case 'hydrated':
        return new ClaudeAgentAdapter({
          ...base, cwd: spec.cwd,
          hydratedHistory: spec.history,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
        });
    }
  };
}

/** Claude adapter registration descriptor. */
export const claudeRegistration: AdapterRegistration = {
  vendor: 'claude',
  discovery: claudeDiscovery,
  available: (config) => {
    if (config.pathToClaudeCodeExecutable) {
      cachedBinaryPath = config.pathToClaudeCodeExecutable;
      return true;
    }
    cachedBinaryPath = findClaudeBinary();
    return cachedBinaryPath !== undefined;
  },
  createFactory,
};
