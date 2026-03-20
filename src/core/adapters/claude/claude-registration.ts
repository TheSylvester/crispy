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
import { getSettingsSnapshotInternal } from '../../settings/index.js';

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
  // If permissionMode is set, this is a CLI dispatch (full agent), not a
  // Rosie summarize session. Don't restrict tools or turns.
  if ('permissionMode' in spec && spec.permissionMode) return {};
  return {
    maxTurns: 1,
    settingSources: [] as SettingSource[],
    tools: [] as string[],
    mcpServers: undefined,
  };
}

/**
 * Read saved turn defaults from settings (permission mode, bypass, etc.).
 *
 * Resume and fork sessions don't carry permission config in their spec —
 * they inherit from the user's saved defaults so the adapter starts with
 * the correct permission mode instead of falling back to SDK defaults.
 */
function getTurnDefaultsConfig(): Record<string, unknown> {
  const { settings } = getSettingsSnapshotInternal();
  const td = settings.turnDefaults;
  return {
    ...(td.permissionMode && { permissionMode: td.permissionMode }),
    ...(td.allowDangerouslySkipPermissions && { allowDangerouslySkipPermissions: true }),
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
      ...(config.plugins && { plugins: config.plugins }),
      ...(prompt && {
        systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: prompt },
      }),
    };
  };

  return (spec) => {
    switch (spec.mode) {
      case 'resume': {
        const model = getResumeModel(spec.sessionId);
        const sessionCwd = claudeDiscovery.findSession(spec.sessionId)?.projectPath ?? config.cwd;
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: sessionCwd, resume: spec.sessionId,
          ...(model && { model }),
          ...(spec.env && { env: spec.env }),
          ...getTurnDefaultsConfig(),
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
      case 'fork': {
        const forkCwd = claudeDiscovery.findSession(spec.fromSessionId)?.projectPath ?? config.cwd;
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: forkCwd, resume: spec.fromSessionId, forkSession: true,
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
          // Apply saved turn defaults (permission mode, bypass) — fork specs
          // don't carry these, but ephemeral forks (buildEphemeralConfig) may
          // override permissionMode, so turn defaults come after.
          ...(!spec.skipPersistSession && getTurnDefaultsConfig()),
        });
      }
      case 'hydrated':
        return new ClaudeAgentAdapter({
          ...getBase(), cwd: spec.cwd,
          hydratedHistory: spec.history,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.skipPersistSession && { skipPersistSession: true }),
          ...(spec.env && { env: spec.env }),
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
