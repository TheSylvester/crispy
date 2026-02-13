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
  VendorDiscovery,
  ChannelMessage,
  SendOptions,
  SessionInfo as AgentSessionInfo,
} from '../../agent-adapter.js';
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
  PermissionResult,
  PermissionMode,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { AsyncIterableQueue } from '../../async-iterable-queue.js';
import { adaptClaudeEntry } from './claude-entry-adapter.js';
import { parseJsonlFile, extractMetadataFast } from './jsonl-reader.js';

import type { TranscriptEntry, ContextUsage, MessageContent } from '../../transcript.js';

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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

/**
 * MCP server configuration — supports all SDK transport types.
 */
export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

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
  /** Save session to disk (default: true) */
  persistSession?: boolean;

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

  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
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

export interface McpSetServersResult {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
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
  modifiedAt: Date;
  size: number;
  label?: string;
  lastMessage?: string;
  vendor: 'claude';
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
  readonly vendor = 'claude';

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

  private readonly options: ClaudeSessionOptions;

  constructor(options: ClaudeSessionOptions) {
    this.options = options;
    this._sessionId = options.resume;
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

  send(content: MessageContent, options?: SendOptions): void {
    if (this._closed) {
      throw new Error('Channel is closed');
    }
    if (this._status === 'awaiting_approval') {
      throw new Error('Cannot send while awaiting approval');
    }

    // Apply send options to session config before starting the query.
    // When a query is already active these won't affect the current SDK
    // options, but they'll be used for the next startQuery().
    if (options) {
      if (options.model !== undefined) {
        this.options.model = options.model || undefined;
      }
      if (options.permissionMode !== undefined) {
        this.options.permissionMode = options.permissionMode as Options['permissionMode'];
      }
      if (options.allowDangerouslySkipPermissions !== undefined) {
        this.options.allowDangerouslySkipPermissions = options.allowDangerouslySkipPermissions;
      }
    }

    const sdkMessage = this.toSDKUserMessage(content);

    if (!this.activeQuery || !this.inputQueue) {
      // No active session — spin up a new query().
      // Options were applied above, so startQuery reads this.options
      // with the caller's model/permissionMode already merged in.
      this.startQuery(sdkMessage);
    } else {
      // Session is running — apply mid-stream option changes directly
      // to the active Query before enqueuing the message.
      if (options?.permissionMode) {
        this.activeQuery.setPermissionMode(options.permissionMode as PermissionMode);
      }
      this.inputQueue.enqueue(sdkMessage);
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
    await this.requireQuery('setModel').setModel(model);
  }

  /** Change permission mode mid-conversation. */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.requireQuery('setPermissionMode').setPermissionMode(mode);
  }

  /** Change thinking token budget mid-conversation. */
  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    await this.requireQuery('setMaxThinkingTokens').setMaxThinkingTokens(tokens);
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

  /** Dynamically set MCP servers. */
  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> {
    return await this.requireQuery('setMcpServers').setMcpServers(servers) as McpSetServersResult;
  }

  // --------------------------------------------------------------------------
  // Query lifecycle
  // --------------------------------------------------------------------------

  private startQuery(firstMessage: SDKUserMessage): void {
    this.inputQueue = new AsyncIterableQueue<SDKUserMessage>();
    this.inputQueue.enqueue(firstMessage);

    this.abortController = new AbortController();

    // Reset per-session state so stale data from a prior query isn't exposed
    this._metadata = null;
    this._contextUsage = null;

    const opts = this.options;

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
      ...(opts.env && { env: opts.env }),
      ...(opts.extraArgs && { extraArgs: opts.extraArgs }),

      // Limits
      ...(opts.maxTurns !== undefined && { maxTurns: opts.maxTurns }),
      ...(opts.maxBudgetUsd !== undefined && { maxBudgetUsd: opts.maxBudgetUsd }),

      // Subagents
      ...(opts.agents && { agents: opts.agents }),
      ...(opts.agent && { agent: opts.agent }),

      // MCP servers
      ...(opts.mcpServers && { mcpServers: opts.mcpServers }),
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

      // Adapter invariants — always applied last, cannot be overridden.
      // The adapter depends on partial messages for streaming and provides
      // its own canUseTool to wire the approval flow.
      abortController: this.abortController,
      includePartialMessages: true,
      canUseTool: (toolName, input, canUseOpts) => this.handleCanUseTool(toolName, input, canUseOpts),
    };

    this.activeQuery = query({
      prompt: this.inputQueue,
      options: sdkOptions,
    });

    this.emitStatus('active');
    this.drainOutput();
  }

  private teardownQuery(): void {
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

    try {
      for await (const sdkMessage of this.activeQuery) {
        if (this._closed) break;
        this.handleSDKMessage(sdkMessage);
      }
    } catch (err) {
      if (!this._closed) {
        this.outputQueue.enqueue({
          type: 'event',
          event: {
            type: 'notification',
            kind: 'error',
            error: err instanceof Error ? err : String(err),
          },
        });
      }
    } finally {
      // Query ended (normally or via error) — clean up and go idle.
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
        this.emitStatus('idle');
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

    // --- Context usage extraction ---
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
      const cw = this._contextUsage?.contextWindow ?? 200_000;
      const cwSource = this._contextUsage?.contextWindowSource ?? 'default';
      this._contextUsage = {
        tokens,
        totalTokens,
        contextWindow: cw,
        contextWindowSource: cwSource,
        percent: Math.min(Math.round((totalTokens / cw) * 100), 100),
        totalCostUsd: this._contextUsage?.totalCostUsd,
      };
    }

    this.emitEntry(msg);
  }

  private handleUserMessage(msg: SDKUserMessage): void {
    // Skip replayed messages (they're history, not new content)
    if ('isReplay' in msg && (msg as { isReplay?: boolean }).isReplay) return;
    this.emitEntry(msg);
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
            contextWindowSource: 'sdk',
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

    // Result marks end-of-turn — transition to idle so subscribers know
    // streaming has stopped. The query stays alive (waiting for next user
    // input via inputQueue), so drainOutput's finally block won't fire
    // until the query is fully closed/aborted.
    this.emitStatus('idle');
  }

  private handleSystemMessage(msg: SDKMessage): void {
    const systemMsg = msg as SDKSystemMessage | SDKStatusMessage | SDKCompactBoundaryMessage;

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

      default:
        // Hook messages, task notifications, etc. — pass through
        this.emitEntry(msg);
        break;
    }
  }

  private handleStreamEvent(msg: SDKPartialAssistantMessage): void {
    this.emitEntry(msg);
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
  private emitStatus(status: 'idle' | 'active'): void {
    this._status = status;
    this.outputQueue.enqueue({
      type: 'event',
      event: { type: 'status', status },
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

      sessions.push({
        sessionId,
        path: filePath,
        projectSlug: slug,
        modifiedAt: stat.mtime,
        size: stat.size,
        label: meta?.label,
        lastMessage: meta?.lastMessage,
        vendor: 'claude',
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

    return {
      sessionId,
      path: filePath,
      projectSlug: slug,
      modifiedAt: stat.mtime,
      size: stat.size,
      label: meta?.label,
      lastMessage: meta?.lastMessage,
      vendor: 'claude',
    };
  }

  return undefined;
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
  return rawEntries
    .map((entry) => adaptClaudeEntry(entry as unknown as Record<string, unknown>))
    .filter((entry): entry is TranscriptEntry => entry !== null);
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
};
