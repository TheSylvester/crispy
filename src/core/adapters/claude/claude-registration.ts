/**
 * Claude adapter registration descriptor.
 *
 * Exports everything the host's adapter-registry needs to register the
 * Claude adapter: discovery, factory builder, and availability check.
 *
 * @module adapters/claude/claude-registration
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
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
  // Build base per-invocation. mcpServerFactory creates fresh MCP server
  // instances each query — avoids the SDK's "already connected" error.
  const getBase = () => ({
    ...(config.pathToClaudeCodeExecutable && {
      pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
    }),
    ...(config.mcpServerFactory && { mcpServerFactory: config.mcpServerFactory }),
  });

  return (spec) => {
    switch (spec.mode) {
      case 'resume': {
        const model = getResumeModel(spec.sessionId);
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: config.cwd, resume: spec.sessionId,
          ...(model && { model }),
        });
      }
      case 'fresh': {
        // Ephemeral session config: Rosie (no mcpServers) gets single-turn/no tools;
        // recall agent (with mcpServers) gets unlimited turns + all tools available.
        // The recall prompt instructs the model to use only MCP tools; allowedTools
        // auto-approves MCP calls so no permission prompts can hang. Built-in tools
        // (Read, Bash, etc.) remain available but the model rarely uses them.
        // No maxTurns — the dispatch timeout (120s) is the only constraint.
        const freshEphemeral = spec.skipPersistSession
          ? spec.mcpServers
            ? { settingSources: [] as SettingSource[], mcpServers: spec.mcpServers as Record<string, McpServerConfig>, allowedTools: ['mcp__crispy_memory__*'] }
            : { maxTurns: 1, settingSources: [] as SettingSource[], tools: [] as string[], mcpServers: undefined }
          : {};
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: spec.cwd,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.extraArgs && { extraArgs: spec.extraArgs }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.env && { env: spec.env }),
          ...freshEphemeral,
        });
      }
      case 'fork': {
        const forkEphemeral = spec.skipPersistSession
          ? spec.mcpServers
            ? { settingSources: [] as SettingSource[], mcpServers: spec.mcpServers as Record<string, McpServerConfig>, allowedTools: ['mcp__crispy_memory__*'] }
            : { maxTurns: 1, settingSources: [] as SettingSource[], tools: [] as string[], mcpServers: undefined }
          : {};
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: config.cwd, resume: spec.fromSessionId, forkSession: true,
          ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.outputFormat && { outputFormat: spec.outputFormat }),
          ...(spec.model && { model: spec.model }),
          ...(spec.env && { env: spec.env }),
          // Structured output forks should complete in a single model response.
          ...(spec.outputFormat && { maxTurns: 1 }),
          ...forkEphemeral,
        });
      }
      case 'hydrated':
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: spec.cwd,
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
