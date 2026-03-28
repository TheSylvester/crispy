/**
 * Claude Agent Adapter
 *
 * Implements the AgentAdapter interface for Claude Code via the Agent SDK.
 * Manages the full lifecycle: input queue, query() calls, SDKMessage
 * mapping, permission handling, session transitions, metadata capture,
 * context tracking, and live session controls.
 *
 * Also exports free functions for disk-based history loading and
 * session discovery (listProjects, listSessions, findSession, loadHistory).
 *
 * @module claude-code-adapter
 */

import type {
  AgentAdapter,
  AdapterSettings,
  VendorDiscovery,
  ChannelMessage,
  TurnSettings,
  SessionInfo as AgentSessionInfo,
} from '../../agent-adapter.js';
import { log } from '../../log.js';
import type { ChannelStatus } from '../../channel-events.js';
import type { ApprovalOption } from '../../channel-events.js';

import type {
  Query,
  Options,
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKStatusMessage,
  SDKCompactBoundaryMessage,
  SDKTaskStartedMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKLocalCommandOutputMessage,
  SDKElicitationCompleteMessage,
  PermissionResult,
  PermissionMode,
  PermissionUpdate,
  McpServerConfig,
  McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

import { query, forkSession } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnOptions as SDKSpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { platform } from 'os';
import { AsyncIterableQueue } from '../../async-iterable-queue.js';
import { adaptClaudeEntry, adaptClaudeEntries } from './claude-entry-adapter.js';
import { parseJsonlFile, extractMetadataFast, readLinesFromOffset, extractInitModel, scanUserMessages } from './jsonl-reader.js';
import { loadSubagentEntries } from './subagent-loader.js';
import {
  serializeToClaudeJsonl,
  writeSyntheticSession,
} from './claude-history-serializer.js';

import type { TranscriptEntry, ContentBlock, TextBlock, ThinkingBlock, ContextUsage, MessageContent, Vendor } from '../../transcript.js';
import type { ChannelEvent } from '../../channel-events.js';

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { homedir } from 'os';
import { getSessionTitleFromDb } from '../../activity-index.js';
import { getContextWindowTokens } from '../../model-utils.js';

// ============================================================================
// Configuration — Full SDK Options Surface
// ============================================================================

/** Setting sources for Claude Code configuration loading. */
export type SettingSource = 'user' | 'project' | 'local';

/**
 * Subagent definition for programmatic agent configuration.
 * Passed via `agents` option to define custom subagents.
 */
export interface AgentDefinition {
  /** Natural language description of when to use this agent */
  description: string;
  /** Allowed tool names. If omitted, inherits all tools */
  tools?: string[];
  /** Tool names to explicitly disallow for this agent */
  disallowedTools?: string[];
  /** The agent's system prompt */
  prompt: string;
  /** Model override: 'sonnet' | 'opus' | 'haiku' | 'inherit' */
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  /** MCP servers available to this agent */
  mcpServers?: (string | Record<string, McpServerConfig>)[];
  /** Maximum number of agentic turns */
  maxTurns?: number;
}

// Re-export McpServerConfig for external consumers
export type { McpServerConfig };

/**
 * Hook event types for intercepting agent operations.
 */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCompleted';

/** Simplified hook callback type. */
export type HookCallback = (
  input: unknown,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

/**
 * Full session options for creating a ClaudeAgentAdapter.
 *
 * Covers the entire SDK Options surface. `cwd` is the only required field.
 * `canUseTool` is intentionally omitted — the adapter always provides its
 * own internally to wire the approval flow. Consumers control permissions
 * via `permissionMode`.
 */
export interface ClaudeSessionOptions {
  // --- Vendor ---

  /** Vendor identity — defaults to 'claude'. */
  vendor?: Vendor;

  // --- Session identity ---

  /** Working directory for the session (required) */
  cwd: string;
  /** Session ID to resume */
  resume?: string;
  /** Specific session ID to use (must be valid UUID) */
  sessionId?: string;
  /** Fork to new session ID when resuming */
  forkSession?: boolean;
  /** Resume at specific message UUID (for mid-conversation forks) */
  resumeSessionAt?: string;
  /** Continue the most recent conversation */
  continue?: boolean;
  /** Pre-loaded cross-vendor history for hydrated sessions (consumed in Phase 2). */
  hydratedHistory?: TranscriptEntry[];
  /** Save session to disk (default: true) */
  persistSession?: boolean;
  /** Skip persisting session to disk (Rosie Bot side-sessions). Inverse of persistSession. */
  skipPersistSession?: boolean;

  // --- Model & thinking ---

  /** Claude model to use */
  model?: string;
  /** Fallback model if primary fails */
  fallbackModel?: string;
  /** Maximum tokens for extended thinking */
  maxThinkingTokens?: number;

  // --- Permissions ---

  /** Permission mode */
  permissionMode?: PermissionMode;
  /** Required when permissionMode is 'bypassPermissions' */
  allowDangerouslySkipPermissions?: boolean;
  /** MCP tool name for permission prompts */
  permissionPromptToolName?: string;

  // --- Tools ---

  /** Tool configuration: array of names or preset */
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  /** Whitelist of allowed tool names */
  allowedTools?: string[];
  /** Blacklist of disallowed tool names */
  disallowedTools?: string[];

  // --- System prompt ---

  /** System prompt: string or preset with optional append */
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };

  // --- Settings & config ---

  /** Which filesystem settings to load (default: ['user', 'project', 'local']) */
  settingSources?: SettingSource[];
  /** Additional directories Claude can access beyond cwd */
  additionalDirectories?: string[];
  /** Environment variables for the subprocess */
  env?: Record<string, string>;
  /** Extra CLI arguments (e.g., { chrome: null }) */
  extraArgs?: Record<string, string | null>;

  // --- Limits ---

  /** Maximum conversation turns */
  maxTurns?: number;
  /** Maximum budget in USD */
  maxBudgetUsd?: number;

  // --- Subagents ---

  /** Programmatic subagent definitions */
  agents?: Record<string, AgentDefinition>;
  /** Agent name for the main thread */
  agent?: string;

  // --- MCP servers ---

  /** MCP server configurations (static — used by ephemeral child sessions). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Factory that creates fresh MCP server instances per-query. Receives the calling session's identity for provenance. */
  mcpServerFactory?: (callerSessionId: string, callerVendor: string) => Record<string, McpServerConfig>;
  /** Enforce strict MCP validation */
  strictMcpConfig?: boolean;

  // --- Plugins ---

  /** Plugins to load */
  plugins?: Array<{ type: 'local'; path: string }>;

  // --- Hooks ---

  /** Hook callbacks for agent events */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;

  // --- Sandbox ---

  /** Sandbox configuration for command execution */
  sandbox?: Record<string, unknown>;

  // --- Structured output ---

  /** JSON Schema output format for structured responses */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };

  // --- Beta features ---

  /** Enable beta features (e.g., ['context-1m-2025-08-07']) */
  betas?: ('context-1m-2025-08-07')[];

  // --- File checkpointing ---

  /** Enable file change tracking for rewindFiles() */
  enableFileCheckpointing?: boolean;

  // --- Process control ---

  /** External abort controller */
  abortController?: AbortController;
  /** JavaScript runtime override */
  executable?: 'bun' | 'deno' | 'node';
  /** Arguments to pass to the runtime */
  executableArgs?: string[];
  /** Path to Claude Code executable */
  pathToClaudeCodeExecutable?: string;
  /** Stderr callback for subprocess output */
  stderr?: (data: string) => void;

  // --- Debug ---

  /** Enable debug mode */
  debug?: boolean;
  /** Write debug logs to a specific file path */
  debugFile?: string;
}

// ============================================================================
// Session Metadata — Captured from SDK init message
// ============================================================================

/**
 * Metadata captured from the SDK's system/init message.
 * Available on channel.metadata after the first init message arrives.
 */
export interface ClaudeSessionMetadata {
  sessionId: string;
  model: string;
  cwd: string;
  tools: string[];
  mcpServers: Array<{ name: string; status: string }>;
  slashCommands: string[];
  skills: string[];
  plugins: Array<{ name: string; path: string }>;
  agents: string[];
  permissionMode: string;
  apiKeySource: string;
}

// ============================================================================
// Discovery / Query Types — returned by session control methods
// ============================================================================

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
  error?: string;
}

export interface RewindFilesResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
}

export interface SDKControlInitializeResponse {
  commands: SlashCommand[];
  output_style: string;
  available_output_styles: string[];
  models: ModelInfo[];
  account: AccountInfo;
}

// ============================================================================
// Session Discovery / History Types
// ============================================================================

export interface SessionInfo {
  sessionId: string;
  path: string;
  projectSlug: string;
  /** Real absolute path to the project directory (e.g. "/home/user/my-project"). */
  projectPath?: string;
  modifiedAt: Date;
  size: number;
  label?: string;
  lastMessage?: string;
  vendor: 'claude';
  isSidechain?: boolean;
}

// ============================================================================
// Pending Approval
// ============================================================================

interface PendingApproval {
  toolUseId: string;
  resolve: (result: PermissionResult) => void;
  /** Original tool input — passed back as updatedInput on allow. */
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  /** Valid option IDs for this approval request. */
  validOptionIds: string[];
}

// ============================================================================
// ClaudeAgentAdapter
// ============================================================================

export class ClaudeAgentAdapter implements AgentAdapter {
  readonly vendor: Vendor = 'claude';

  private _sessionId: string | undefined;
  private _status: ChannelStatus = 'idle';
  private _closed = false;
  private _metadata: ClaudeSessionMetadata | null = null;
  private _contextUsage: ContextUsage | null = null;

  /** The input queue fed to query() as the prompt. */
  private inputQueue: AsyncIterableQueue<SDKUserMessage> | null = null;
  /** The active Query object returned by query(). */
  private activeQuery: Query | null = null;
  /** The combined output stream consumers read from. */
  private outputQueue = new AsyncIterableQueue<ChannelMessage>();
  /** Pending approval requests keyed by toolUseId. */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** AbortController for the active query. */
  private abortController: AbortController | null = null;
  /** Generation counter to prevent stale drainOutput() finally blocks from clobbering new queries. */
  private queryGeneration = 0;
  /** Counter for sendTurn() echo suppression — decremented when SDK echoes back user messages. */
  private pendingSendCount = 0;
  /** Path to synthetic JSONL file written for hydrated sessions (cleaned up on close). */
  private syntheticSessionPath: string | undefined;
  /** MCP servers created for the current query — closed on teardown. */
  private activeMcpServers: Record<string, McpServerConfig> | null = null;
  /** Number of background agents/tasks currently running. */
  private backgroundTaskCount = 0;
  /** Per-instance temp dir so nested CLI processes don't purge each other's
   *  Bash tool output files (they all share /tmp/claude-<uid>/<slug>/tasks/). */
  private readonly instanceTmpdir: string;

  // --- Streaming delta accumulator ---
  /** Buffer for accumulating streaming deltas into renderable content blocks. */
  private streamingBlocks: ContentBlock[] = [];
  /** Tracks accumulated partial JSON for tool_use input (keyed by block index). */
  private streamingPartialJson = new Map<number, string>();
  /** Throttle timer for streaming_content emission. */
  private streamingEmitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Minimum interval between streaming_content emissions (ms). */
  private static readonly STREAMING_EMIT_INTERVAL = 16; // ~60fps

  private readonly options: ClaudeSessionOptions;

  constructor(options: ClaudeSessionOptions) {
    this.options = options;
    this.vendor = options.vendor ?? 'claude';
    this._sessionId = options.resume;
    // Each adapter gets its own tmpdir so multiple CLI instances don't
    // purge each other's Bash tool output files on startup.
    this.instanceTmpdir = mkdtempSync(join(tmpdir(), 'claude-session-'));
  }

  // --------------------------------------------------------------------------
  // Channel interface
  // --------------------------------------------------------------------------

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get status(): ChannelStatus {
    return this._status;
  }

  /** Session metadata captured from the SDK init message. */
  get metadata(): ClaudeSessionMetadata | null {
    return this._metadata;
  }

  /** Cumulative context usage (updated after each assistant/result message). */
  get contextUsage(): ContextUsage | null {
    return this._contextUsage;
  }

  /** Current session settings (model, permission mode, bypass, extra args). */
  get settings(): AdapterSettings {
    return {
      vendor: this.vendor,
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      allowDangerouslySkipPermissions: this.options.allowDangerouslySkipPermissions ?? false,
      extraArgs: this.options.extraArgs,
    };
  }

  /**
   * The combined output stream.
   *
   * **Single-consumer only.** The underlying AsyncIterableQueue can only
   * be iterated once. If multiple consumers are needed, use a fan-out
   * mechanism on top of this.
   */
  messages(): AsyncIterable<ChannelMessage> {
    return this.outputQueue;
  }

  sendTurn(content: MessageContent, settings: TurnSettings): void {
    if (this._closed) {
      throw new Error('Channel is closed');
    }
    if (this._status === 'awaiting_approval') {
      throw new Error('Cannot send while awaiting approval');
    }

    const needsRestart = this.diffNeedsRestart(settings);
    this.applySettings(settings);

    // If restart-requiring settings changed and we have an active query, tear it down
    if (needsRestart && this.activeQuery) {
      // Sync session ID so the next query resumes correctly
      this.options.resume = this._sessionId;
      // Clear one-shot flags that shouldn't carry over
      this.options.sessionId = undefined;
      this.options.forkSession = undefined;
      this.options.continue = undefined;
      this.options.resumeSessionAt = undefined;

      this.teardownQuery();
      this.pendingSendCount = 0;
    }

    const sdkMessage = this.toSDKUserMessage(content);

    if (this.activeQuery && this.inputQueue) {
      // Session is running — apply live-changeable settings and enqueue
      if (settings.model !== undefined) {
        this.activeQuery.setModel(settings.model || undefined);
      }
      if (settings.permissionMode !== undefined) {
        this.activeQuery.setPermissionMode(settings.permissionMode as PermissionMode);
      }
      this.pendingSendCount++;
      this.inputQueue.enqueue(sdkMessage);
    } else {
      // No active session — spin up a new query
      this.pendingSendCount++;
      this.startQuery(sdkMessage);
    }
  }

  /**
   * Check if settings changes require a query restart.
   *
   * allowDangerouslySkipPermissions and extraArgs are only applied at query
   * creation time — changing them mid-session requires tearing down and
   * restarting the query.
   */
  private diffNeedsRestart(settings: TurnSettings): boolean {
    // Check bypass permission change
    if (settings.allowDangerouslySkipPermissions !== undefined) {
      const current = this.options.allowDangerouslySkipPermissions ?? false;
      if (settings.allowDangerouslySkipPermissions !== current) {
        return true;
      }
    }

    // Check extraArgs change (deep compare via JSON.stringify)
    if (settings.extraArgs !== undefined) {
      const currentJson = JSON.stringify(this.options.extraArgs ?? {});
      const newJson = JSON.stringify(settings.extraArgs);
      if (currentJson !== newJson) {
        return true;
      }
    }

    return false;
  }

  /**
   * Apply settings to the adapter's options.
   *
   * Called before sending a turn to ensure all settings are captured.
   */
  private applySettings(settings: TurnSettings): void {
    if (settings.model !== undefined) {
      this.options.model = settings.model || undefined;
    }
    if (settings.permissionMode !== undefined) {
      this.options.permissionMode = settings.permissionMode as Options['permissionMode'];
    }
    if (settings.allowDangerouslySkipPermissions !== undefined) {
      this.options.allowDangerouslySkipPermissions = settings.allowDangerouslySkipPermissions;
    }
    if (settings.extraArgs !== undefined) {
      this.options.extraArgs = settings.extraArgs;
    }
    if (settings.outputFormat !== undefined) {
      this.options.outputFormat = settings.outputFormat;
    }
  }

  respondToApproval(toolUseId: string, optionId: string, extra?: {
    message?: string;
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: unknown[];
  }): void {
    const pending = this.pendingApprovals.get(toolUseId);
    if (!pending) {
      throw new Error(`No pending approval for toolUseId: ${toolUseId}`);
    }
    if (!pending.validOptionIds.includes(optionId)) {
      throw new Error(`Invalid optionId '${optionId}' for toolUseId: ${toolUseId}. Valid: ${pending.validOptionIds.join(', ')}`);
    }

    this.pendingApprovals.delete(toolUseId);

    let result: PermissionResult;

    if (optionId === 'deny') {
      // Zv6 deny schema requires `message: string` — always provide one.
      result = { behavior: 'deny', message: extra?.message ?? 'User denied', toolUseID: toolUseId };
    } else {
      // Zv6 allow schema requires `updatedInput: Record<string, unknown>` (NOT
      // optional, despite the .d.ts saying so — the wire-protocol Zod schema
      // demands it). Pass the original input unchanged; fall back to {} if
      // input is somehow nullish (shouldn't happen, but defensive).
      //
      // For 'allow_session', propagate SDK-provided suggestions as
      // updatedPermissions so the SDK persists the permission rule.
      result = {
        behavior: 'allow',
        updatedInput: pending.input ?? {},
        toolUseID: toolUseId,
      };

      if (optionId !== 'allow' && pending.suggestions && pending.suggestions.length > 0) {
        result.updatedPermissions = pending.suggestions;
      }

      // extra.updatedPermissions overrides if provided (ExitPlanMode)
      if (extra?.updatedPermissions) {
        result.updatedPermissions = extra.updatedPermissions as PermissionUpdate[];
      }

      // extra.updatedInput merges over pending.input (AskUserQuestion answers)
      if (extra?.updatedInput) {
        result.updatedInput = { ...result.updatedInput, ...extra.updatedInput };
      }
    }

    pending.resolve(result);

    // Only transition to 'active' if no more pending approvals
    if (this.pendingApprovals.size === 0) {
      this.emitStatus('active');
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;

    this.teardownQuery();

    // Clean up synthetic JSONL file written for hydrated sessions
    if (this.syntheticSessionPath) {
      try { unlinkSync(this.syntheticSessionPath); } catch { /* best-effort */ }
      this.syntheticSessionPath = undefined;
    }

    // Clean up per-instance tmpdir (created in constructor to isolate Bash tool output)
    try { rmSync(this.instanceTmpdir, { recursive: true, force: true }); } catch { /* best-effort */ }

    // Reset background counter — adapter teardown always goes fully idle
    this.backgroundTaskCount = 0;
    this.emitStatus('idle');
    this.outputQueue.done();
  }

  // --------------------------------------------------------------------------
  // Live control methods (delegate to active Query)
  // --------------------------------------------------------------------------

  private requireQuery(method: string): Query {
    if (!this.activeQuery) throw new Error(`Cannot call ${method}() before session is initialized`);
    if (this._closed) throw new Error(`Cannot call ${method}() on a closed channel`);
    return this.activeQuery;
  }

  /** Interrupt the active query (pause, not kill). */
  async interrupt(): Promise<void> {
    await this.requireQuery('interrupt').interrupt();
  }

  /** Change model mid-conversation. */
  async setModel(model?: string): Promise<void> {
    this.options.model = model;
    await this.requireQuery('setModel').setModel(model);
  }

  /** Change permission mode mid-conversation. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.options.permissionMode = mode;
    await this.requireQuery('setPermissionMode').setPermissionMode(mode);
  }

  /** Change thinking token budget mid-conversation. */
  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    await this.requireQuery('setMaxThinkingTokens').setMaxThinkingTokens(tokens);
  }

  /**
   * Tear down the current query and update options so the next send()
   * creates a fresh SDK query() with updated bypass / extraArgs.
   * Only callable when idle (no streaming in progress).
   */
  prepareQueryRestart(updates: {
    allowDangerouslySkipPermissions?: boolean;
    extraArgs?: Record<string, string | null>;
  }): void {
    if (this._closed) throw new Error('Cannot call prepareQueryRestart() on a closed channel');
    if (this._status !== 'idle') throw new Error('Cannot call prepareQueryRestart() while session is not idle');

    // Fast path: no active query to tear down (e.g. subscribed but no message sent yet)
    if (!this.activeQuery) {
      if (updates.allowDangerouslySkipPermissions !== undefined) {
        this.options.allowDangerouslySkipPermissions = updates.allowDangerouslySkipPermissions;
      }
      if (updates.extraArgs !== undefined) {
        this.options.extraArgs = updates.extraArgs;
      }
      return;
    }

    // Sync session ID: _sessionId is updated from every SDK message but
    // options.resume is only set at construction. Without this the next
    // startQuery() wouldn't resume the correct session.
    this.options.resume = this._sessionId;

    // Clear one-shot flags that shouldn't carry over to the next query
    this.options.sessionId = undefined;
    this.options.forkSession = undefined;
    this.options.continue = undefined;
    this.options.resumeSessionAt = undefined;

    // Apply caller's updates
    if (updates.allowDangerouslySkipPermissions !== undefined) {
      this.options.allowDangerouslySkipPermissions = updates.allowDangerouslySkipPermissions;
    }
    if (updates.extraArgs !== undefined) {
      this.options.extraArgs = updates.extraArgs;
    }

    this.teardownQuery();
  }

  /** Get full initialization data (commands, models, account, etc.). */
  async initializationResult(): Promise<SDKControlInitializeResponse> {
    return await this.requireQuery('initializationResult').initializationResult() as SDKControlInitializeResponse;
  }

  /** List available models with display info. */
  async supportedModels(): Promise<ModelInfo[]> {
    return await this.requireQuery('supportedModels').supportedModels() as ModelInfo[];
  }

  /** List available slash commands. */
  async supportedCommands(): Promise<SlashCommand[]> {
    return await this.requireQuery('supportedCommands').supportedCommands() as SlashCommand[];
  }

  /** Check MCP server connection status. */
  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return await this.requireQuery('mcpServerStatus').mcpServerStatus() as McpServerStatus[];
  }

  /** Get account/organization info. */
  async accountInfo(): Promise<AccountInfo> {
    return await this.requireQuery('accountInfo').accountInfo() as AccountInfo;
  }

  /** Rewind files to state at a specific user message UUID. */
  async rewindFiles(userMessageId: string, opts?: { dryRun?: boolean }): Promise<RewindFilesResult> {
    return await this.requireQuery('rewindFiles').rewindFiles(userMessageId, opts) as RewindFilesResult;
  }

  /** Reconnect an MCP server by name. */
  async reconnectMcpServer(serverName: string): Promise<void> {
    await this.requireQuery('reconnectMcpServer').reconnectMcpServer(serverName);
  }

  /** Enable or disable an MCP server by name. */
  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    await this.requireQuery('toggleMcpServer').toggleMcpServer(serverName, enabled);
  }

  /**
   * Close active MCP servers created for the current query.
   *
   * Idempotent — safe to call multiple times (null-checks + null-out).
   * Fire-and-forget: close errors are logged but don't propagate.
   */
  private closeMcpServers(): void {
    const servers = this.activeMcpServers;
    if (!servers) return;
    this.activeMcpServers = null;

    for (const [name, config] of Object.entries(servers)) {
      if (this.isSdkServer(config)) {
        config.instance.close().catch((err: unknown) => {
          log({ level: 'error', source: 'claude-adapter', summary: `Failed to close MCP server '${name}': ${err instanceof Error ? (err as Error).message : String(err)}`, data: { name, error: String(err) } });
        });
      }
    }
  }

  /** Type guard: narrow McpServerConfig to SDK-type with a closeable instance. */
  private isSdkServer(config: McpServerConfig): config is McpSdkServerConfigWithInstance {
    return 'instance' in config;
  }

  // --------------------------------------------------------------------------
  // Query lifecycle
  // --------------------------------------------------------------------------

  private startQuery(firstMessage: SDKUserMessage): void {
    this.queryGeneration++;
    this.inputQueue = new AsyncIterableQueue<SDKUserMessage>();
    this.inputQueue.enqueue(firstMessage);

    this.abortController = new AbortController();

    // Reset per-session state so stale data from a prior query isn't exposed
    this._metadata = null;
    this._contextUsage = null;

    const opts = this.options;

    // Resolve MCP servers for this query:
    // - Ephemeral child sessions (recall/Rosie) use static opts.mcpServers
    // - Regular sessions call the factory for fresh instances each query
    this.closeMcpServers(); // Clean up any leftover from a prior query
    if (opts.mcpServers) {
      this.activeMcpServers = opts.mcpServers;
    } else if (opts.mcpServerFactory) {
      try {
        const servers = opts.mcpServerFactory(this.sessionId ?? '', this.vendor);
        this.activeMcpServers = Object.keys(servers).length ? servers : null;
      } catch (err) {
        log({ level: 'error', source: 'claude-adapter', summary: `Failed to create MCP servers: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
        this.activeMcpServers = null;
      }
    } else {
      this.activeMcpServers = null;
    }

    // Build SDK options — map all ClaudeSessionOptions fields, apply defaults,
    // then lock adapter invariants (abortController, canUseTool, includePartialMessages)
    // last so they can't be overridden.
    const sdkOptions: Options = {
      // Session identity
      cwd: opts.cwd,
      ...(opts.resume && { resume: opts.resume }),
      ...(opts.sessionId && { sessionId: opts.sessionId }),
      ...(opts.forkSession !== undefined && { forkSession: opts.forkSession }),
      ...(opts.resumeSessionAt && { resumeSessionAt: opts.resumeSessionAt }),
      ...(opts.continue !== undefined && { continue: opts.continue }),
      ...(opts.persistSession !== undefined && { persistSession: opts.persistSession }),
      ...(opts.skipPersistSession && { persistSession: false }),

      // Model & thinking
      ...(opts.model && { model: opts.model }),
      ...(opts.fallbackModel && { fallbackModel: opts.fallbackModel }),
      ...(opts.maxThinkingTokens !== undefined && { maxThinkingTokens: opts.maxThinkingTokens }),

      // Permissions
      ...(opts.permissionMode && { permissionMode: opts.permissionMode }),
      ...(opts.allowDangerouslySkipPermissions !== undefined && { allowDangerouslySkipPermissions: opts.allowDangerouslySkipPermissions }),
      ...(opts.permissionPromptToolName && { permissionPromptToolName: opts.permissionPromptToolName }),

      // Tools
      ...(opts.tools && { tools: opts.tools }),
      ...(opts.allowedTools && { allowedTools: opts.allowedTools }),
      ...(opts.disallowedTools && { disallowedTools: opts.disallowedTools }),

      // System prompt
      ...(opts.systemPrompt && { systemPrompt: opts.systemPrompt }),

      // Settings & config — default to loading all filesystem settings
      settingSources: opts.settingSources ?? ['user', 'project', 'local'],
      ...(opts.additionalDirectories && { additionalDirectories: opts.additionalDirectories }),
      // MCP tool calls (e.g. recall) can take 60s+; the SDK kills the stream
      // after CLAUDE_CODE_STREAM_CLOSE_TIMEOUT of inactivity (default 60s).
      // Default to 120s so long-running MCP tools don't get aborted.
      env: {
        ...process.env,
        CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '120000',
        CLAUDE_CODE_TMPDIR: this.instanceTmpdir,
        ...opts.env,
      },
      ...(opts.extraArgs && { extraArgs: opts.extraArgs }),

      // Limits
      ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
      ...(opts.maxBudgetUsd !== undefined && { maxBudgetUsd: opts.maxBudgetUsd }),

      // Subagents
      ...(opts.agents && { agents: opts.agents }),
      ...(opts.agent && { agent: opts.agent }),

      // MCP servers — resolved in startQuery() from static mcpServers (ephemeral)
      // or factory (regular sessions).
      ...(this.activeMcpServers && { mcpServers: this.activeMcpServers }),
      ...(opts.strictMcpConfig !== undefined && { strictMcpConfig: opts.strictMcpConfig }),

      // Plugins
      ...(opts.plugins && { plugins: opts.plugins }),

      // Hooks
      ...(opts.hooks && { hooks: opts.hooks }),

      // Sandbox
      ...(opts.sandbox && { sandbox: opts.sandbox }),

      // Structured output
      ...(opts.outputFormat && { outputFormat: opts.outputFormat }),

      // Beta features
      ...(opts.betas && { betas: opts.betas }),

      // File checkpointing
      ...(opts.enableFileCheckpointing !== undefined && { enableFileCheckpointing: opts.enableFileCheckpointing }),

      // Process control
      ...(opts.executable && { executable: opts.executable }),
      ...(opts.executableArgs && { executableArgs: opts.executableArgs }),
      ...(opts.pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable }),
      ...(opts.stderr && { stderr: opts.stderr }),

      // Debug
      ...(opts.debug !== undefined && { debug: opts.debug }),
      ...(opts.debugFile && { debugFile: opts.debugFile }),

      // Windows: use shell spawn to avoid stdin/stdout pipe deadlocks.
      // Node.js on Windows can buffer stdin writes indefinitely without
      // shell: true, preventing the SDK's control protocol from initializing.
      ...(platform() === 'win32' && {
        spawnClaudeCodeProcess: (spawnOpts: SDKSpawnOptions) => {
          const child = spawn(spawnOpts.command, spawnOpts.args, {
            cwd: spawnOpts.cwd,
            env: spawnOpts.env,
            signal: spawnOpts.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            windowsHide: true,
          });
          return child;
        },
      }),

      // Adapter invariants — always applied last, cannot be overridden.
      // The adapter depends on partial messages for streaming and provides
      // its own canUseTool to wire the approval flow.
      abortController: this.abortController,
      includePartialMessages: true,
      canUseTool: (toolName, input, canUseOpts) => this.handleCanUseTool(toolName, input, canUseOpts),
    };

    // Hydrated session: write a synthetic JSONL file and configure the SDK
    // to resume from it (forked, so Claude creates its own session ID).
    if (opts.hydratedHistory) {
      const syntheticId = randomUUID();
      const jsonl = serializeToClaudeJsonl(opts.hydratedHistory, syntheticId, opts.cwd);
      this.syntheticSessionPath = writeSyntheticSession(syntheticId, opts.cwd, jsonl);

      sdkOptions.resume = syntheticId;
      sdkOptions.forkSession = true;

      // Consumed — don't re-hydrate on subsequent query restarts
      opts.hydratedHistory = undefined;
    }

    this.activeQuery = query({
      prompt: this.inputQueue,
      options: sdkOptions,
    });

    this.emitStatus('active');
    this.drainOutput();
  }

  private teardownQuery(): void {
    // Close MCP servers before tearing down the query — fire-and-forget
    this.closeMcpServers();

    // Clear streaming buffer so ghost entry disappears
    this.clearStreamingBuffer();

    // Abort the active query
    this.abortController?.abort();
    this.abortController = null;

    // Close the input queue
    if (this.inputQueue) {
      this.inputQueue.done();
      this.inputQueue = null;
    }

    // Close the active query
    if (this.activeQuery) {
      this.activeQuery.close();
      this.activeQuery = null;
    }

    // Reset echo suppression counter
    this.pendingSendCount = 0;

    // Deny any pending approvals (take snapshot to avoid mutation during iteration)
    const pendingEntries = [...this.pendingApprovals.values()];
    this.pendingApprovals.clear();
    for (const pending of pendingEntries) {
      pending.resolve({ behavior: 'deny', message: 'Session ended', toolUseID: pending.toolUseId });
    }
  }

  /**
   * Drain the active query's async generator, mapping each SDKMessage
   * to channel output (entries + events).
   */
  private async drainOutput(): Promise<void> {
    if (!this.activeQuery) return;

    // Capture the generation at the start of this drain loop. If a new query
    // is started (via prepareQueryRestart → teardownQuery → send → startQuery)
    // before our finally block runs, the generation will have advanced and we
    // must not clobber the new query's state.
    const generation = this.queryGeneration;

    try {
      for await (const sdkMessage of this.activeQuery) {
        if (this._closed) break;
        this.handleSDKMessage(sdkMessage);
      }
    } catch (err) {
      if (!this._closed) {
        log({
          source: 'session',
          level: 'error',
          summary: `Adapter: query error (${this._sessionId?.slice(0, 12) ?? 'unknown'}…)`,
          data: { sessionId: this._sessionId, error: err instanceof Error ? err.message : String(err) },
        });
        this.outputQueue.enqueue({
          type: 'event',
          event: {
            type: 'notification',
            kind: 'error',
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } finally {
      // Query ended (normally or via error) — clean up and go idle.
      // Only mutate instance state if no newer query has started.
      if (this.queryGeneration === generation) {
        // Close MCP servers — idempotent, safe even if teardownQuery already called it
        this.closeMcpServers();

        // Clear streaming buffer so ghost entry disappears on error/completion
        this.clearStreamingBuffer();

        // Clear pending approvals (same cleanup as teardownQuery).
        const pendingEntries = [...this.pendingApprovals.values()];
        this.pendingApprovals.clear();
        for (const pending of pendingEntries) {
          pending.resolve({ behavior: 'deny', message: 'Session ended', toolUseID: pending.toolUseId });
        }

        this.activeQuery = null;
        this.inputQueue = null;
        this.abortController = null;
        if (!this._closed) {
          this.emitStatus(this.backgroundTaskCount > 0 ? 'background' : 'idle');
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // SDKMessage → ChannelMessage mapping
  // --------------------------------------------------------------------------

  private handleSDKMessage(msg: SDKMessage): void {
    // Track session ID from every message
    if ('session_id' in msg && msg.session_id) {
      const prev = this._sessionId;
      this._sessionId = msg.session_id;
      if (prev !== msg.session_id) {
        this.outputQueue.enqueue({
          type: 'event',
          event: {
            type: 'notification',
            kind: 'session_changed',
            sessionId: msg.session_id,
            ...(prev && { previousSessionId: prev }),
          },
        });
      }
    }

    switch (msg.type) {
      case 'assistant':
        this.handleAssistantMessage(msg as SDKAssistantMessage);
        break;

      case 'user':
        this.handleUserMessage(msg as SDKUserMessage);
        break;

      case 'result':
        this.handleResultMessage(msg as SDKResultMessage);
        break;

      case 'system':
        this.handleSystemMessage(msg);
        break;

      case 'stream_event':
        this.handleStreamEvent(msg as SDKPartialAssistantMessage);
        break;

      case 'tool_progress':
        // Tool progress — could emit as metadata in the future
        break;

      case 'auth_status':
        // Auth status — could surface as a notification
        break;

      case 'prompt_suggestion':
        // Predicted next user prompt (SDK 0.2.63+) — pass through as entry
        this.emitEntry(msg);
        break;

      case 'rate_limit_event':
        // Rate limit info update (SDK 0.2.63+) — pass through as entry
        this.emitEntry(msg);
        break;

      default:
        // Unknown message types (tool_use_summary, etc.) — pass through
        this.emitEntry(msg);
        break;
    }
  }

  private handleAssistantMessage(msg: SDKAssistantMessage): void {
    // Skip replayed messages — they're history already backfilled via loadHistory().
    // Letting them through would duplicate entries and, more critically, would
    // emit 'active' status before the replayed result emits 'idle', causing flicker.
    if ('isReplay' in msg && (msg as { isReplay?: boolean }).isReplay) return;

    if (this._status !== 'active') this.emitStatus('active');

    // Sub-agent assistant messages must NOT update _contextUsage — their usage
    // and model reflect the child session (e.g. Haiku 200k), not the parent.
    // Without this guard, a Haiku sub-agent message arriving before the main
    // Opus message locks contextWindow to 200k for the entire turn.
    if (msg.parent_tool_use_id !== null) {
      this.emitEntry(msg);
      return;
    }

    // --- Context usage extraction (top-level messages only) ---
    // Assistant messages carry per-turn usage snapshot (not incremental).
    // Extract message.usage for token breakdown.
    const betaUsage = (msg.message as unknown as Record<string, unknown>)?.usage as Record<string, number> | undefined;
    if (betaUsage && typeof betaUsage === 'object') {
      const tokens = {
        input: betaUsage.input_tokens ?? 0,
        output: betaUsage.output_tokens ?? 0,
        cacheCreation: betaUsage.cache_creation_input_tokens ?? 0,
        cacheRead: betaUsage.cache_read_input_tokens ?? 0,
      };
      const totalTokens = tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;
      // Always recalculate contextWindow from the current message's model.
      // Using ?? to preserve a prior value caused stale 200k windows when the
      // first message in a turn happened to be from a sub-agent (now guarded
      // above), but even for top-level messages we want the latest model's window.
      const msgModel = (msg.message as unknown as Record<string, unknown>)?.model as string | undefined;
      const cw = getContextWindowTokens('claude', msgModel ?? this.options.model);
      this._contextUsage = {
        tokens,
        totalTokens,
        contextWindow: cw,
        percent: Math.min(Math.round((totalTokens / cw) * 100), 100),
        totalCostUsd: this._contextUsage?.totalCostUsd,
      };
    }

    // Emit real entry FIRST so the webview has it before the ghost clears.
    // This prevents a visible gap (separate WebSocket frames = separate renders).
    this.emitEntry(msg);
    this.clearStreamingBuffer();
  }

  private handleUserMessage(msg: SDKUserMessage): void {
    // Skip replayed messages (they're history, not new content)
    if ('isReplay' in msg && (msg as { isReplay?: boolean }).isReplay) return;

    // Skip SDK-injected synthetic messages (slash command echoes like /model,
    // meta messages, transcript-only entries). These have isSynthetic: true
    // and are not real user input — letting them through pollutes the transcript
    // and causes rewind to prefill with command XML instead of real user text.
    if ('isSynthetic' in msg && (msg as { isSynthetic?: boolean }).isSynthetic) return;

    // Tool-result user messages are system-generated (Claude Code feeding tool
    // output back to the model). They must NEVER be swallowed by echo
    // suppression — only the original user text input should be skipped.
    // Detect tool results by checking for tool_use_result (structured result
    // data) or tool_result content blocks in the message.
    const isToolResult = 'tool_use_result' in msg || this.hasToolResultContent(msg);

    // Skip echo if this was sent via sendTurn() — channel already broadcast it.
    // Only suppress genuine user-input echoes, never tool results.
    if (!isToolResult && this.pendingSendCount > 0) {
      this.pendingSendCount--;
      return;
    }

    this.emitEntry(msg);
  }

  /**
   * Check if a user message contains tool_result content blocks.
   * These are system-generated messages carrying tool execution output
   * back to the model — not user-typed input echoes.
   */
  private hasToolResultContent(msg: SDKUserMessage): boolean {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (block) => typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result',
    );
  }

  private handleResultMessage(msg: SDKResultMessage): void {
    // Replayed result messages are history — don't emit them as entries or
    // transition state. Without this guard, a resumed session replays its
    // prior result which flips the channel to 'idle' before the new turn's
    // assistant messages arrive, causing a visible glow-off/glow-on flicker.
    if ('isReplay' in msg && (msg as { isReplay?: boolean }).isReplay) return;

    // --- Context usage: authoritative contextWindow from SDK ModelUsage ---
    const resultMsg = msg as unknown as Record<string, unknown>;
    const sdkModelUsage = resultMsg.modelUsage as Record<string, Record<string, number>> | undefined;

    if (sdkModelUsage && this._contextUsage) {
      for (const mu of Object.values(sdkModelUsage)) {
        if (mu.contextWindow) {
          this._contextUsage = {
            ...this._contextUsage,
            contextWindow: mu.contextWindow,
            percent: Math.min(Math.round((this._contextUsage.totalTokens / mu.contextWindow) * 100), 100),
          };
          break;
        }
      }
    }

    // --- Cumulative cost ---
    if (resultMsg.total_cost_usd !== undefined && this._contextUsage) {
      this._contextUsage = { ...this._contextUsage, totalCostUsd: resultMsg.total_cost_usd as number };
    }

    this.emitEntry(msg);

    // Result marks end-of-turn — transition to idle (or background if agents
    // are still running) so subscribers know streaming has stopped. The query
    // stays alive (waiting for next user input via inputQueue), so
    // drainOutput's finally block won't fire until the query is fully
    // closed/aborted.
    this.emitStatus(this.backgroundTaskCount > 0 ? 'background' : 'idle',
      this.backgroundTaskCount > 0 ? undefined : { turnComplete: true });
  }

  private handleSystemMessage(msg: SDKMessage): void {
    const systemMsg = msg as
      | SDKSystemMessage | SDKStatusMessage | SDKCompactBoundaryMessage
      | SDKTaskStartedMessage | SDKTaskNotificationMessage | SDKTaskProgressMessage
      | SDKLocalCommandOutputMessage | SDKElicitationCompleteMessage;

    if (!('subtype' in systemMsg)) {
      // System message without subtype — pass through as entry
      this.emitEntry(msg);
      return;
    }

    switch (systemMsg.subtype) {
      case 'init': {
        // --- Capture session metadata from init message ---
        const initMsg = msg as unknown as Record<string, unknown>;
        this._metadata = {
          sessionId: (initMsg.session_id as string) ?? '',
          model: (initMsg.model as string) ?? '',
          cwd: (initMsg.cwd as string) ?? '',
          tools: (initMsg.tools as string[]) ?? [],
          mcpServers: (initMsg.mcp_servers as Array<{ name: string; status: string }>) ?? [],
          slashCommands: (initMsg.slash_commands as string[]) ?? [],
          skills: (initMsg.skills as string[]) ?? [],
          plugins: (initMsg.plugins as Array<{ name: string; path: string }>) ?? [],
          agents: (initMsg.agents as string[]) ?? [],
          permissionMode: ((initMsg.permissionMode ?? initMsg.permission_mode) as string) ?? '',
          apiKeySource: ((initMsg.apiKeySource ?? initMsg.api_key_source) as string) ?? '',
        };

        // --- Sync options from init so adapter.settings reflects actual state ---
        // The SDK's init message reports the authoritative model and permissionMode
        // the session is actually using. For resumed sessions the adapter is created
        // with a bare { mode: 'resume', sessionId } spec — options are empty.
        // Without this sync, adapter.settings returns undefined for everything
        // and late subscribers can't pick up the session's real settings.
        //
        // Only back-fill model from init when options.model is empty (resume case).
        // If options.model is already set (e.g. "opus" from send()), keep it —
        // the SDK init reports the full model string ("claude-opus-4-...") which
        // would clobber the short name the UI understands.
        let settingsChanged = false;
        if (this._metadata.model && !this.options.model) {
          this.options.model = this._metadata.model;
          settingsChanged = true;
        }
        // Only backfill permission mode from SDK init when no explicit mode was
        // set — avoids clobbering the user's UI-selected mode with whatever the
        // SDK reports on startup.
        if (this._metadata.permissionMode && !this.options.permissionMode) {
          this.options.permissionMode = this._metadata.permissionMode as Options['permissionMode'];
          settingsChanged = true;
        }

        // Emit settings_changed so ControlPanel picks up the corrected
        // model and permissionMode. Only emit when init actually backfilled
        // values (resume case) — for fresh sessions where options were already
        // set, this would clobber the UI-friendly short model name with the
        // full SDK model string the dropdown can't represent.
        if (settingsChanged) {
          this.emitSettingsChanged();
        }

        // Re-emit current status so the channel broadcasts a fresh state_changed
        // with the now-populated settings snapshot.
        if (this._status === 'active') {
          this.emitStatus('active');
        }

        // System init — emit as entry for metadata (tools, model, etc.)
        this.emitEntry(msg);
        break;
      }

      case 'status': {
        const statusMsg = systemMsg as SDKStatusMessage;
        if (statusMsg.status === 'compacting') {
          this.outputQueue.enqueue({
            type: 'event',
            event: { type: 'notification', kind: 'compacting' },
          });
        }
        // Only emit when the SDK's mode genuinely differs from what we
        // requested — suppresses the boot echo where the SDK reports its
        // default mode before processing our requested mode.
        if (
          statusMsg.permissionMode &&
          statusMsg.permissionMode !== this.options.permissionMode
        ) {
          this.options.permissionMode = statusMsg.permissionMode as Options['permissionMode'];
          this.outputQueue.enqueue({
            type: 'event',
            event: {
              type: 'notification',
              kind: 'permission_mode_changed',
              mode: statusMsg.permissionMode,
            },
          });
        }
        break;
      }

      case 'compact_boundary':
        // Compact boundary — emit as entry so UI can render a divider
        this.emitEntry(msg);
        break;

      // Background agent lifecycle
      case 'task_started':
        this.backgroundTaskCount++;
        this.emitEntry(msg);
        break;
      case 'task_notification': {
        this.backgroundTaskCount = Math.max(0, this.backgroundTaskCount - 1);
        this.emitEntry(msg);
        // All background tasks finished while in background state → go idle
        if (this.backgroundTaskCount === 0 && this._status === 'background') {
          this.emitStatus('idle');
        }
        break;
      }

      // SDK 0.2.63+ system subtypes — pass through as entries
      case 'task_progress':       // Background agent progress with usage
        this.emitEntry(msg);
        break;
      case 'local_command_output': // Slash command output — no model turn started
        this.emitEntry(msg);
        // The SDK processed this locally (e.g. unknown /skill, /model, /usage).
        // No model turn will follow, so emit idle to clear the UI's optimistic
        // 'streaming' state. This is the authoritative signal — no timer needed.
        this.emitStatus('idle', { turnComplete: true });
        break;
      case 'elicitation_complete': // MCP elicitation done
        this.emitEntry(msg);
        break;

      default:
        // Hook messages, etc. — pass through
        this.emitEntry(msg);
        break;
    }
  }

  private handleStreamEvent(msg: SDKPartialAssistantMessage): void {
    // Only stream top-level assistant messages — ignore sub-agent deltas
    if (msg.parent_tool_use_id !== null) return;

    const event = msg.event;

    switch (event.type) {
      case 'message_start':
        // Reset buffer for new message
        this.streamingBlocks = [];
        this.streamingPartialJson.clear();
        break;

      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'text') {
          this.streamingBlocks[event.index] = { type: 'text', text: '' };
        } else if (block.type === 'tool_use') {
          this.streamingBlocks[event.index] = {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: {},
          };
          this.streamingPartialJson.set(event.index, '');
        } else if (block.type === 'thinking') {
          this.streamingBlocks[event.index] = {
            type: 'thinking',
            thinking: '',
          };
        }
        // Other block types (redacted_thinking, server_tool_use, etc.) — skip
        this.scheduleStreamingEmit();
        break;
      }

      case 'content_block_delta': {
        const existing = this.streamingBlocks[event.index];
        if (!existing) break;

        const delta = event.delta;
        if (delta.type === 'text_delta' && existing.type === 'text') {
          (existing as TextBlock).text += delta.text;
        } else if (delta.type === 'input_json_delta' && existing.type === 'tool_use') {
          const prev = this.streamingPartialJson.get(event.index) ?? '';
          this.streamingPartialJson.set(event.index, prev + delta.partial_json);
        } else if (delta.type === 'thinking_delta' && existing.type === 'thinking') {
          (existing as ThinkingBlock).thinking += delta.thinking;
        }
        this.scheduleStreamingEmit();
        break;
      }

      case 'content_block_stop': {
        // Try to parse accumulated JSON for tool_use blocks
        const existing = this.streamingBlocks[event.index];
        if (existing?.type === 'tool_use') {
          const json = this.streamingPartialJson.get(event.index) ?? '';
          try {
            (existing as { input: unknown }).input = JSON.parse(json);
          } catch {
            // Leave input as {}
          }
          this.streamingPartialJson.delete(event.index);
        }
        this.scheduleStreamingEmit();
        break;
      }

      case 'message_stop':
        // The complete assistant message arrives BEFORE message_stop (confirmed
        // by spike testing). handleAssistantMessage has already cleared the
        // buffer. This flush is a no-op safety net for edge cases.
        this.flushStreamingEmit();
        break;

      case 'message_delta':
        // Contains stop_reason and usage — not needed for streaming display
        break;
    }
  }

  /** Schedule a throttled streaming_content emission (~60fps). */
  private scheduleStreamingEmit(): void {
    if (this.streamingEmitTimer !== null) return;
    if (this.streamingBlocks.length === 0) return;
    this.streamingEmitTimer = setTimeout(() => {
      this.streamingEmitTimer = null;
      this.flushStreamingEmit();
    }, ClaudeAgentAdapter.STREAMING_EMIT_INTERVAL);
  }

  /** Emit a snapshot of current accumulated streaming content. */
  private flushStreamingEmit(): void {
    if (this.streamingEmitTimer !== null) {
      clearTimeout(this.streamingEmitTimer);
      this.streamingEmitTimer = null;
    }
    if (this.streamingBlocks.length === 0) return;

    // Filter out undefined slots (sparse array from index-based assignment)
    const content = this.streamingBlocks.filter(Boolean);
    if (content.length === 0) return;

    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'streaming_content',
        content: content.map(block => ({ ...block })),
      } as unknown as ChannelEvent,
    });
  }

  /** Clear the streaming buffer and emit a clear signal to the webview. */
  private clearStreamingBuffer(): void {
    // Cancel any pending throttle timer
    if (this.streamingEmitTimer !== null) {
      clearTimeout(this.streamingEmitTimer);
      this.streamingEmitTimer = null;
    }

    // Skip if nothing was streaming — avoids redundant content:null events
    // when called from multiple cleanup paths (teardownQuery + drainOutput finally)
    const wasStreaming = this.streamingBlocks.length > 0 || this.streamingPartialJson.size > 0;
    this.streamingBlocks = [];
    this.streamingPartialJson.clear();

    if (!wasStreaming) return;

    // Emit null to signal the webview to remove the ghost entry
    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'streaming_content',
        content: null,
      } as unknown as ChannelEvent,
    });
  }

  // --------------------------------------------------------------------------
  // Permission handling
  // --------------------------------------------------------------------------

  private handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
      agentID?: string;
    },
  ): Promise<PermissionResult> {
    const toolUseId = opts.toolUseID;

    // If already aborted, deny immediately
    if (opts.signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: 'Aborted', toolUseID: toolUseId });
    }

    return new Promise<PermissionResult>((resolve) => {
      // Build approval options based on what the SDK provides
      const options: ApprovalOption[] = [
        { id: 'allow', label: 'Allow once' },
      ];

      if (opts.suggestions && opts.suggestions.length > 0) {
        options.push({ id: 'allow_session', label: 'Always allow', description: 'Remember this permission' });
      }

      options.push({ id: 'deny', label: 'Deny' });

      const validOptionIds = options.map((o) => o.id);

      // Store the pending approval (including input for updatedInput on allow)
      this.pendingApprovals.set(toolUseId, {
        toolUseId,
        resolve,
        input,
        suggestions: opts.suggestions,
        validOptionIds,
      });

      // Emit the awaiting_approval status
      this.outputQueue.enqueue({
        type: 'event',
        event: {
          type: 'status',
          status: 'awaiting_approval',
          toolUseId,
          toolName,
          input,
          reason: opts.decisionReason,
          options,
        },
      });

      this._status = 'awaiting_approval';

      // If aborted while waiting, auto-deny
      opts.signal.addEventListener('abort', () => {
        if (this.pendingApprovals.has(toolUseId)) {
          this.pendingApprovals.delete(toolUseId);
          resolve({ behavior: 'deny', message: 'Aborted', toolUseID: toolUseId });
          // Transition back to 'active' if no more pending approvals
          if (this.pendingApprovals.size === 0) {
            this.emitStatus('active');
          }
        }
      }, { once: true });
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Convert MessageContent to an SDKUserMessage for the input queue.
   */
  private toSDKUserMessage(content: MessageContent): SDKUserMessage {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: typeof content === 'string'
          ? content
          : content.map((block) => {
              if (block.type === 'text') {
                return { type: 'text' as const, text: block.text };
              }
              // Image blocks — narrow media_type from generic string to the
              // SDK's expected union at the adapter boundary.
              return {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: block.source.data,
                },
              };
            }) as ContentBlockParam[],
      },
      parent_tool_use_id: null,
      session_id: this._sessionId ?? '',
    };
  }

  /**
   * Map an SDKMessage to a TranscriptEntry via the existing entry adapter
   * and emit it to the output queue.
   *
   * NOTE: adaptClaudeEntry was designed for JSONL disk records, not live
   * SDK messages. It produces usable but sparse entries for SDK messages
   * (missing some identity fields). A dedicated SDK message adapter is
   * planned as future work.
   */
  private emitEntry(msg: SDKMessage): void {
    const entry = adaptClaudeEntry(msg as unknown as Record<string, unknown>);
    if (entry) {
      this.outputQueue.enqueue({ type: 'entry', entry });
    }
  }

  /**
   * Emit a status change event and update the internal status.
   */
  private emitStatus(status: 'idle' | 'active' | 'background', extra?: { turnComplete?: true }): void {
    this._status = status;
    this.outputQueue.enqueue({
      type: 'event',
      event: { type: 'status', status, ...extra },
    });
  }

  /**
   * Emit a settings_changed notification so the UI can sync model/permissionMode.
   */
  private emitSettingsChanged(): void {
    if (this._closed) return;
    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'settings_changed',
        settings: this.settings,
      },
    });
  }
}

// ============================================================================
// History / Disk Functions (free functions — no instance state needed)
// ============================================================================

/** Base directory for Claude projects. */
function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * List all project directory names under ~/.claude/projects/.
 *
 * @returns Array of project slug strings (directory names)
 */
export function listProjects(): string[] {
  const dir = claudeProjectsDir();
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * List sessions, optionally filtered by project slug.
 *
 * If `projectSlug` is provided, lists only that project's .jsonl files.
 * If omitted, lists sessions across all projects.
 *
 * Uses `extractMetadataFast` for efficient label extraction (reads only
 * the first 64KB of each file).
 *
 * @param projectSlug - Optional project directory name to filter by
 * @returns Array of SessionInfo sorted by modifiedAt descending
 */
export function listSessions(projectSlug?: string): SessionInfo[] {
  const baseDir = claudeProjectsDir();
  if (!existsSync(baseDir)) return [];

  const slugs = projectSlug ? [projectSlug] : listProjects();
  const sessions: SessionInfo[] = [];

  for (const slug of slugs) {
    const projectDir = join(baseDir, slug);

    let files: string[];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(projectDir, file);
      const sessionId = file.replace(/\.jsonl$/, '');

      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }

      const meta = extractMetadataFast(filePath);

      // Skip trivial/warmup sessions (sub-agent pre-warming, empty files, etc.)
      if (meta?.isTrivial) {
        continue;
      }

      const gen3Title = getSessionTitleFromDb(sessionId);

      // Prefer the last transcript entry's timestamp over filesystem mtime
      // for accurate sort order — mtime can drift due to atomic writes, rsync, etc.
      const modifiedAt = meta?.lastTimestamp
        ? new Date(meta.lastTimestamp)
        : stat.mtime;

      sessions.push({
        sessionId,
        path: filePath,
        projectSlug: slug,
        projectPath: meta?.projectPath,
        modifiedAt,
        size: stat.size,
        label: meta?.label,
        lastMessage: meta?.lastMessage,
        vendor: 'claude',
        isSidechain: meta?.isSidechain,
        ...(gen3Title && { title: gen3Title }),
      });
    }
  }

  // Sort by most recently modified first
  sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return sessions;
}

/**
 * Find a session by ID across all projects.
 *
 * Walks all project directories to find a matching .jsonl file.
 *
 * @param sessionId - Session UUID to search for
 * @returns SessionInfo if found, undefined otherwise
 */
export function findSession(sessionId: string): SessionInfo | undefined {
  const baseDir = claudeProjectsDir();
  if (!existsSync(baseDir)) return undefined;

  const filename = `${sessionId}.jsonl`;

  for (const slug of listProjects()) {
    const filePath = join(baseDir, slug, filename);
    if (!existsSync(filePath)) continue;

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }

    const meta = extractMetadataFast(filePath);
    const gen3Title = getSessionTitleFromDb(sessionId);
    const modifiedAt = meta?.lastTimestamp
      ? new Date(meta.lastTimestamp)
      : stat.mtime;

    return {
      sessionId,
      path: filePath,
      projectSlug: slug,
      projectPath: meta?.projectPath,
      modifiedAt,
      size: stat.size,
      label: meta?.label,
      lastMessage: meta?.lastMessage,
      vendor: 'claude',
      isSidechain: meta?.isSidechain,
      ...(gen3Title && { title: gen3Title }),
    };
  }

  return undefined;
}

/**
 * Extract the model string for a resumed session by reading its JSONL init entry.
 *
 * Convenience wrapper: finds the session file on disk, then reads the first 8KB
 * to extract the model from the `{ type: "system", subtype: "init" }` entry.
 * Used by adapter factories to populate model at construction time (before any
 * SDK query), so the catchup message includes the correct model.
 *
 * @param sessionId - The session UUID to look up
 * @returns The model string (e.g. "claude-sonnet-4-20250514"), or undefined
 */
export function getResumeModel(sessionId: string): string | undefined {
  const info = findSession(sessionId);
  if (!info) return undefined;
  return extractInitModel(info.path);
}

/**
 * Load full transcript history from a session file on disk.
 *
 * Parses the JSONL file and adapts each entry to universal TranscriptEntry
 * format. Async signature for interface compatibility.
 *
 * @param sessionPath - Absolute path to the .jsonl session file
 * @returns Array of TranscriptEntry (nulls from adaptation are filtered)
 */
export async function loadHistory(sessionPath: string): Promise<TranscriptEntry[]> {
  const rawEntries = parseJsonlFile(sessionPath);
  let entries = rawEntries
    .map((entry) => adaptClaudeEntry(entry as unknown as Record<string, unknown>))
    .filter((entry): entry is TranscriptEntry => entry !== null);

  // Load sub-agent transcripts and merge into the entry stream
  entries = loadSubagentEntries(sessionPath, entries);
  return entries;
}

// ============================================================================
// Vendor Discovery — static discovery object for session-manager
// ============================================================================

/**
 * Static discovery object for Claude — satisfies VendorDiscovery.
 *
 * Wraps the module-scope free functions (findSession, listSessions,
 * loadHistory) into the VendorDiscovery interface shape. No instance
 * state — session-manager uses this for stateless discovery ops.
 */
export const claudeDiscovery: VendorDiscovery = {
  vendor: 'claude',
  findSession,
  listSessions,
  async loadHistory(sessionId: string): Promise<TranscriptEntry[]> {
    const info = findSession(sessionId);
    if (!info) return [];
    return loadHistory(info.path);
  },

  readSubagentEntries(sessionId, agentId, parentToolUseId, cursor) {
    const info = findSession(sessionId);
    if (!info) return { entries: [], cursor, done: true };

    const sessionDir = info.path.replace(/\.jsonl$/, '');
    const subagentPath = join(sessionDir, 'subagents', `agent-${agentId}.jsonl`);

    const fromOffset = cursor ? parseInt(cursor, 10) : 0;
    const { entries: rawEntries, newOffset } = readLinesFromOffset(subagentPath, fromOffset);
    if (rawEntries.length === 0) {
      return { entries: [], cursor: String(fromOffset), done: false };
    }

    const adapted = adaptClaudeEntries(rawEntries as unknown as Record<string, unknown>[]);
    for (const entry of adapted) {
      entry.parentToolUseID = parentToolUseId;
    }

    const done = adapted.some((e: TranscriptEntry) => e.type === 'result');
    return { entries: adapted, cursor: String(newOffset), done };
  },

  scanUserActivity(sessionPath, fromOffset = 0) {
    return scanUserMessages(sessionPath, fromOffset);
  },

  async preFork(sessionId, options) {
    const result = await forkSession(sessionId, {
      upToMessageId: options?.atMessageId,
      dir: options?.dir,
    });
    return { sessionId: result.sessionId };
  },
};

