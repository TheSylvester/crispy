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
 * Build ephemeral adapter config for Rosie child sessions.
 *
 * skipPersistSession + mcpServers → MCP tools available (tracker, recall).
 * skipPersistSession without mcpServers → single-turn, no tools (summarize).
 * The recall prompt instructs the model to use only MCP tools; allowedTools
 * auto-approves MCP calls so no permission prompts can hang.
 */
function buildEphemeralConfig(spec: SessionOpenSpec): Record<string, unknown> {
  if (!('skipPersistSession' in spec) || !spec.skipPersistSession) return {};
  if ('mcpServers' in spec && spec.mcpServers) {
    return {
      settingSources: [] as SettingSource[],
      mcpServers: spec.mcpServers as Record<string, McpServerConfig>,
      allowedTools: ['mcp__crispy-memory__*'],
    };
  }
  return {
    maxTurns: 1,
    settingSources: [] as SettingSource[],
    tools: [] as string[],
    mcpServers: undefined,
  };
}

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
  const getBase = () => {
    const prompt = config.systemPromptFactory?.();
    return {
      ...(config.pathToClaudeCodeExecutable && {
        pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
      }),
      ...(config.mcpServerFactory && { mcpServerFactory: config.mcpServerFactory }),
      ...(prompt && {
        systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: prompt },
      }),
    };
  };

  return (spec) => {
    switch (spec.mode) {
      case 'resume': {
        const model = getResumeModel(spec.sessionId);
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: config.cwd, resume: spec.sessionId,
          ...(model && { model }),
        });
      }
      case 'fresh':
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: spec.cwd,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.extraArgs && { extraArgs: spec.extraArgs }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.env && { env: spec.env }),
          ...(spec.systemPrompt && {
            systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: spec.systemPrompt },
          }),
          ...buildEphemeralConfig(spec),
        });
      case 'fork':
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: config.cwd, resume: spec.fromSessionId, forkSession: true,
          ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.outputFormat && { outputFormat: spec.outputFormat }),
          ...(spec.model && { model: spec.model }),
          ...(spec.env && { env: spec.env }),
          ...(spec.systemPrompt && {
            systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: spec.systemPrompt },
          }),
          // Structured output forks should complete in a single model response.
          ...(spec.outputFormat && { maxTurns: 1 }),
          ...buildEphemeralConfig(spec),
        });
      case 'hydrated':
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: spec.cwd,
          hydratedHistory: spec.history,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.systemPrompt && {
            systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: spec.systemPrompt },
          }),
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
