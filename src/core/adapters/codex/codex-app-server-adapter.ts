/**
 * codex-app-server-adapter.ts
 *
 * Main AgentAdapter implementation for Codex using the app-server child process.
 *
 * Responsibilities:
 * - Own the `codex app-server` process lifecycle
 * - Stream ChannelMessages to consumers via AsyncIterableQueue
 * - Handle turn/start, turn/interrupt, approval flows
 * - Map protocol notifications/requests to channel events
 *
 * Does NOT:
 * - Parse JSONL directly (RPC client handles wire format)
 * - Manage multiple sessions (one adapter per session)
 * - Perform session discovery (codexDiscovery handles that)
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  AgentAdapter,
  ChannelMessage,
  SessionOpenSpec,
  AdapterSettings,
  TurnSettings,
} from '../../agent-adapter.js';
import { log } from '../../log.js';
import type { ChannelEvent, ChannelStatus } from '../../channel-events.js';
import type {
  ContentBlock,
  ContextUsage,
  MessageContent,
  Vendor,
} from '../../transcript.js';
import { CRISPY_VERSION } from '../../version.js';
import { AsyncIterableQueue } from '../../async-iterable-queue.js';
import { CodexRpcClient } from './codex-rpc-client.js';
import { adaptCodexItem } from './codex-entry-adapter.js';
import { serializeToCodexHistory } from './codex-history-serializer.js';
import {
  codexApprovalToEvent,
  crispyResponseToCodexDecision,
  isApprovalRequest,
} from './codex-approval-mapping.js';
import {
  mapPermissionMode,
  mapSandboxMode,
  mapThreadConfig,
  mapTokenUsage,
  mapMessageContent,
  hasExplicitCodexSkillReference,
  mapTurnSettings,
  type ResolvedCodexSkillReference,
} from './codex-settings-mapping.js';
import { codexDiscovery } from './codex-discovery.js';
import type { SkillsListResponse } from './protocol/v2/SkillsListResponse.js';
import type { ThreadItem } from './protocol/v2/ThreadItem.js';
import type { UserInput } from './protocol/v2/UserInput.js';

// ============================================================================
// Types
// ============================================================================

/** Stored pending approval state. */
interface PendingApproval {
  serverRequestId: number | string;
  method: string;
  amendment?: unknown;
}

// ============================================================================
// CodexAgentAdapter
// ============================================================================

export class CodexAgentAdapter implements AgentAdapter {
  readonly vendor: Vendor = 'codex';

  // --- State ---
  private _sessionId: string | undefined;
  private _status: ChannelStatus = 'idle';
  private _contextUsage: ContextUsage | null = null;
  private _settings: AdapterSettings;
  private _closed = false;

  // --- Infrastructure ---
  private client: CodexRpcClient | null = null;
  private outputQueue = new AsyncIterableQueue<ChannelMessage>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private currentThreadId: string | undefined;
  private currentTurnId: string | undefined;
  private startPromise: Promise<void> | null = null;
  /** Echo suppression: decremented when Codex echoes back a userMessage we sent. */
  private pendingSendCount = 0;
  /**
   * Startup phase flag — true until the first turn/started notification.
   * During startup, Codex may emit system-context items (AGENTS.md,
   * environment_context) via thread/resume or thread/start. These items
   * are marked isMeta so the rendering filter and history serializer skip them.
   */
  private startupPhase = true;

  // --- Item tracking for turnComplete ---
  /** Number of item/started events not yet matched by item/completed. */
  private pendingItemCount = 0;
  /** Set when turn/completed fires while items are still pending delivery. */
  private turnCompletedPending = false;
  /** Safety timeout for stuck pendingItemCount — emits plain idle after 10s. */
  private turnCompleteSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Streaming delta accumulator ---
  /** Accumulated text from agentMessage deltas for the current turn. */
  private streamingText = '';
  /** Accumulated thinking text from reasoning deltas for the current turn. */
  private streamingThinking = '';
  /** Throttle timer for streaming_content emission. */
  private streamingEmitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Minimum interval between streaming_content emissions (ms). */
  private static readonly STREAMING_EMIT_INTERVAL = 16; // ~60fps
  private bundledSkillCache = new Map<string, ResolvedCodexSkillReference>();
  private bundledSkillDiscoveryPromise: Promise<Map<string, ResolvedCodexSkillReference>> | null = null;
  private bundledSkillDiscoveryLoaded = false;
  private bundledSkillDiscoveryNeedsReload = true;
  private bundledSkillDiscoveryGeneration = 0;
  private readonly spec: SessionOpenSpec & {
    cwd?: string;
    command?: string;
    args?: string[];
    bundledSkillRoot?: string;
    effectiveCwd?: string;
  };

  constructor(spec: SessionOpenSpec & {
    cwd?: string;
    command?: string;
    args?: string[];
    bundledSkillRoot?: string;
    effectiveCwd?: string;
  }) {
    this.spec = spec;
    this._settings = {
      vendor: 'codex',
      model: 'model' in spec ? spec.model : undefined,
      permissionMode: 'permissionMode' in spec ? spec.permissionMode : undefined,
      allowDangerouslySkipPermissions: false,
      extraArgs: 'extraArgs' in spec ? spec.extraArgs : undefined,
    };

    // Set initial sessionId from spec if resuming/forking
    if (spec.mode === 'resume') {
      this._sessionId = spec.sessionId;
    } else if (spec.mode === 'fork') {
      this._sessionId = spec.fromSessionId;
    }
  }

  // --- Getters ---
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get status(): ChannelStatus {
    return this._status;
  }

  get contextUsage(): ContextUsage | null {
    return this._contextUsage;
  }

  get settings(): AdapterSettings {
    return this._settings;
  }

  // --- Core Methods ---

  messages(): AsyncIterable<ChannelMessage> {
    return this.outputQueue;
  }

  sendTurn(content: MessageContent, settings: TurnSettings): void {
    if (this._closed) {
      throw new Error('Adapter is closed');
    }
    if (this._status === 'awaiting_approval') {
      throw new Error('Cannot send while awaiting approval');
    }

    // Apply settings
    this.applySettings(settings);

    // Track sends for echo suppression — Codex echoes userMessage items back
    this.pendingSendCount++;

    // Ensure started, then execute turn
    if (!this.client) {
      this.startPromise = this.start()
        .then(() => this.executeTurn(content))
        .catch((err) => { this.startPromise = null; this.emitError(err); });
    } else if (this.startPromise) {
      this.startPromise = this.startPromise
        .then(() => this.executeTurn(content))
        .catch((err) => { this.startPromise = null; this.emitError(err); });
    } else {
      this.executeTurn(content).catch((err) => {
        this.emitError(err);
      });
    }
  }

  respondToApproval(
    toolUseId: string,
    optionId: string,
    extra?: {
      message?: string;
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    },
  ): void {
    if (this._closed) {
      throw new Error('Adapter is closed');
    }

    const pending = this.pendingApprovals.get(toolUseId);
    if (!pending) {
      throw new Error(`No pending approval for: ${toolUseId}`);
    }

    this.pendingApprovals.delete(toolUseId);

    const decision = crispyResponseToCodexDecision(
      pending.method,
      optionId,
      extra,
      pending.amendment,
    );

    try {
      this.client?.sendResponse(pending.serverRequestId, decision);
    } catch (err) {
      log({ level: 'error', source: 'codex-adapter', summary: `Failed to send approval response: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
    }

    // Transition back to active if no more pending approvals
    if (this.pendingApprovals.size === 0) {
      // If the turn already completed while we were waiting for approval,
      // apply the deferred-idle logic now instead of emitting active
      if (this.currentTurnId === undefined) {
        if (this.pendingItemCount > 0) {
          this.turnCompletedPending = true;
          this.startTurnCompleteSafetyTimer();
        } else {
          this.emitIdleWithTurnComplete();
          return;
        }
      }
      this.emitStatus('active');
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;

    // Auto-deny pending approvals
    for (const [, pending] of this.pendingApprovals) {
      try {
        this.client?.sendResponse(pending.serverRequestId, { decision: 'cancel' });
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.pendingApprovals.clear();

    // Detach from shared discovery
    codexDiscovery.detachClient();

    // Clear timers and streaming buffer before closing
    this.clearTurnCompleteSafetyTimer();
    this.clearStreamingBuffer();

    // Kill process
    this.client?.kill();
    this.client = null;

    // Set final status and close the queue (bypass emitStatus which checks _closed)
    this._status = 'idle';
    this.outputQueue.enqueue({
      type: 'event',
      event: { type: 'status', status: 'idle' },
    });
    this.outputQueue.done();
  }

  async interrupt(): Promise<void> {
    if (!this.client?.alive || !this.currentThreadId || !this.currentTurnId) {
      return;
    }

    try {
      await this.client.request('turn/interrupt', {
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
      });
    } catch (err) {
      log({ level: 'error', source: 'codex-adapter', summary: `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
    }
  }

  async setModel(model?: string): Promise<void> {
    this._settings = { ...this._settings, model };
    this.emitSettingsChanged();
    // Applied on next turn/start via overrides
  }

  async setPermissionMode(mode: string): Promise<void> {
    this._settings = { ...this._settings, permissionMode: mode };
    this.emitSettingsChanged();
    // Applied on next turn/start via overrides
  }

  // --- Private: Startup ---

  private async start(): Promise<void> {
    if (this.client) return;

    this.bundledSkillDiscoveryPromise = null;
    this.bundledSkillDiscoveryLoaded = false;
    this.bundledSkillDiscoveryNeedsReload = true;
    this.bundledSkillDiscoveryGeneration = 0;
    this.bundledSkillCache.clear();

    // Create RPC client
    this.client = new CodexRpcClient({
      ...(this.spec.command && { command: this.spec.command }),
      ...(this.spec.args && { args: this.spec.args }),
      cwd: (this.spec.mode === 'fresh' || this.spec.mode === 'hydrated') ? this.spec.cwd : undefined,
      // Forward env overrides from spec (Rosie child sessions set CLAUDECODE, MCP timeouts, etc.)
      ...('env' in this.spec && this.spec.env && { env: this.spec.env }),
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, id, params) => this.handleServerRequest(method, id, params),
      onError: (err) => this.emitError(err),
      onExit: (code, signal) => this.handleProcessExit(code, signal),
    });

    // Initialize protocol
    await this.client.request('initialize', {
      clientInfo: { name: 'crispy', version: CRISPY_VERSION },
      capabilities: { experimentalApi: true },
    });

    // Start/resume/fork thread based on spec
    let response: Record<string, unknown>;

    switch (this.spec.mode) {
      case 'fresh': {
        const params: Record<string, unknown> = {
          ...this.buildThreadConfigParams({
            cwd: this.spec.cwd,
            model: this.spec.model,
            permissionMode: this.spec.permissionMode,
            mcpServers: this.spec.mcpServers,
            systemPrompt: this.spec.systemPrompt,
          }),
          experimentalRawEvents: false,
        };
        // Ephemeral sessions for Rosie child dispatches — not persisted by Codex
        if (this.spec.skipPersistSession) {
          params.ephemeral = true;
        }

        response = await this.client.request('thread/start', params);
        break;
      }

      case 'resume': {
        // Don't re-send systemPrompt — the resumed thread already has
        // developerInstructions from its prior session history.
        response = await this.client.request('thread/resume', {
          threadId: this.spec.sessionId,
          ...this.buildThreadConfigParams({
            cwd: this.spec.cwd,
            model: this.spec.model,
            permissionMode: this.spec.permissionMode,
            mcpServers: this.spec.mcpServers,
          }),
        });
        break;
      }

      case 'fork': {
        // Don't re-send systemPrompt — the forked thread inherits the parent's
        // developerInstructions from history. Re-sending causes N+1 copies after
        // N forks (GitHub issue #4).
        const forkParams: Record<string, unknown> = {
          threadId: this.spec.fromSessionId,
          ...this.buildThreadConfigParams({
            model: this.spec.model,
            mcpServers: this.spec.mcpServers,
          }),
        };
        if (this.spec.atMessageId) {
          forkParams.atItemId = this.spec.atMessageId;
        }
        response = await this.client.request('thread/fork', forkParams);
        break;
      }

      case 'hydrated': {
        // Don't re-send systemPrompt — the serialized history already
        // contains the developerInstructions from the source session.
        const history = serializeToCodexHistory(this.spec.history);
        response = await this.client.request('thread/resume', {
          threadId: crypto.randomUUID(),
          history,
          ...this.buildThreadConfigParams({
            cwd: this.spec.cwd,
            model: this.spec.model,
            permissionMode: this.spec.permissionMode,
            mcpServers: this.spec.mcpServers,
          }),
        });
        break;
      }
    }

    // Extract thread info from response
    const thread = response.thread as Record<string, unknown> | undefined;
    const newId = (thread?.id ?? response.threadId) as string | undefined;

    if (newId) {
      const previousId = this._sessionId;
      this._sessionId = newId;
      this.currentThreadId = newId;

      // Emit session changed
      this.outputQueue.enqueue({
        type: 'event',
        event: {
          type: 'notification',
          kind: 'session_changed',
          sessionId: newId,
          ...(previousId && previousId !== newId ? { previousSessionId: previousId } : {}),
        },
      });
    }

    // Update settings from response
    const newSettings = mapThreadConfig(
      response,
      this._settings.permissionMode as TurnSettings['permissionMode'] | undefined,
    );
    this._settings = { ...this._settings, ...newSettings };
    this.emitSettingsChanged();

    // Attach to discovery for shared RPC
    codexDiscovery.attachClient(this.client);

    // History backfill is handled by session-manager via discovery.loadHistory().
    // The adapter only emits *new* entries from live notifications.
  }

  private async executeTurn(content: MessageContent): Promise<void> {
    if (!this.client?.alive || !this.currentThreadId) {
      throw new Error('Client not ready');
    }

    const input = await this.buildTurnInput(content);
    const overrides = mapTurnSettings({
      model: this._settings.model,
      permissionMode: this._settings.permissionMode as TurnSettings['permissionMode'],
      outputFormat: this._outputFormat,
    });

    const response = await this.client.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.currentThreadId,
      input,
      ...overrides,
    });

    this.currentTurnId = response.turn?.id;
    // Status transition to active handled via turn/started notification
  }

  // --- Private: Apply Settings ---

  /** Stored outputFormat for passing to turn/start. */
  private _outputFormat: TurnSettings['outputFormat'];

  private async buildTurnInput(content: MessageContent): Promise<UserInput[]> {
    if (!hasExplicitCodexSkillReference(content)) {
      return mapMessageContent(content);
    }

    const bundledSkills = await this.getBundledSkills();
    const unresolvedSkills = new Set<string>();
    const input = mapMessageContent(content, (name) => {
      const resolvedSkill = bundledSkills.get(name);
      if (!resolvedSkill) {
        unresolvedSkills.add(name);
      }
      return resolvedSkill;
    });

    for (const skillName of unresolvedSkills) {
      log({
        level: 'warn',
        source: 'codex-adapter',
        summary: `Bundled Crispy skill not found for Codex turn: ${skillName}`,
        data: { skillName, discoveredSkills: [...bundledSkills.keys()] },
      });
    }

    return input;
  }

  private async getBundledSkills(): Promise<Map<string, ResolvedCodexSkillReference>> {
    const bundledSkillRoot = this.spec.bundledSkillRoot;
    const effectiveCwd = this.spec.effectiveCwd ?? this.spec.cwd;

    if (!this.client?.alive || !bundledSkillRoot || !effectiveCwd) {
      return this.bundledSkillCache;
    }

    if (!existsSync(bundledSkillRoot)) {
      log({
        level: 'debug',
        source: 'codex-adapter',
        summary: `Bundled Crispy skill root missing for Codex discovery: ${bundledSkillRoot}`,
      });
      return this.bundledSkillCache;
    }

    if (this.bundledSkillDiscoveryLoaded && !this.bundledSkillDiscoveryNeedsReload) {
      return this.bundledSkillCache;
    }

    if (this.bundledSkillDiscoveryPromise) {
      return this.bundledSkillDiscoveryPromise;
    }

    this.bundledSkillDiscoveryPromise = this.discoverBundledSkills(bundledSkillRoot, effectiveCwd)
      .finally(() => {
        this.bundledSkillDiscoveryPromise = null;
      });

    return this.bundledSkillDiscoveryPromise;
  }

  private async discoverBundledSkills(
    bundledSkillRoot: string,
    effectiveCwd: string,
  ): Promise<Map<string, ResolvedCodexSkillReference>> {
    if (!this.client) {
      return this.bundledSkillCache;
    }

    try {
      const discoveryGeneration = this.bundledSkillDiscoveryGeneration;
      const forceReload = this.bundledSkillDiscoveryNeedsReload;
      const response = await this.client.request<SkillsListResponse>('skills/list', {
        cwds: [effectiveCwd],
        forceReload,
        perCwdExtraUserRoots: [{
          cwd: effectiveCwd,
          extraUserRoots: [bundledSkillRoot],
        }],
      });

      const inventory = new Map<string, ResolvedCodexSkillReference>();
      // Try exact CWD match first, then fall back to any entry with bundled skills
      const entry = response.data.find((item) => item.cwd === effectiveCwd)
        ?? response.data.find((item) => item.skills?.some((s) => this.isBundledSkillPath(bundledSkillRoot, s.path)))
        ?? response.data[0];

      for (const skill of entry?.skills ?? []) {
        if (!skill.enabled) {
          continue;
        }

        if (!this.isBundledSkillPath(bundledSkillRoot, skill.path)) {
          continue;
        }

        if (inventory.has(skill.name)) {
          log({
            level: 'debug',
            source: 'codex-adapter',
            summary: `Duplicate bundled Codex skill ignored: ${skill.name}`,
            data: { skillName: skill.name, path: skill.path },
          });
          continue;
        }

        // Read SKILL.md content for self-expansion — Codex app-server doesn't
        // expand `{ type: 'skill' }` inputs, so we inject the content as text.
        let content: string | undefined;
        try {
          content = readFileSync(skill.path, 'utf-8');
        } catch {
          log({
            level: 'warn',
            source: 'codex-adapter',
            summary: `Failed to read bundled skill content: ${skill.path}`,
          });
        }

        inventory.set(skill.name, {
          name: skill.name,
          path: skill.path,
          content,
        });
      }

      this.bundledSkillCache = inventory;
      this.bundledSkillDiscoveryLoaded = true;
      if (this.bundledSkillDiscoveryGeneration === discoveryGeneration) {
        this.bundledSkillDiscoveryNeedsReload = false;
      }
      log({
        level: 'info',
        source: 'codex-adapter',
        summary: `Discovered ${inventory.size} bundled skill(s): ${[...inventory.keys()].join(', ') || '(none)'}`,
        data: { effectiveCwd, entryCount: response.data.length, matchedCwd: entry?.cwd },
      });
      return inventory;
    } catch (err) {
      log({
        level: 'warn',
        source: 'codex-adapter',
        summary: `Failed to discover bundled Codex skills: ${err instanceof Error ? err.message : String(err)}`,
        data: { error: String(err), bundledSkillRoot, effectiveCwd },
      });
      return this.bundledSkillCache;
    }
  }

  private isBundledSkillPath(root: string, candidate: string): boolean {
    const resolvedRoot = resolve(root);
    const rel = relative(resolvedRoot, resolve(candidate));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }

  private buildThreadConfigParams(options: {
    cwd?: string;
    model?: string;
    permissionMode?: TurnSettings['permissionMode'];
    mcpServers?: Record<string, unknown>;
    systemPrompt?: string;
  }): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    if (options.cwd) {
      params.cwd = options.cwd;
    }
    if (options.model) {
      params.model = options.model;
    }
    if (options.permissionMode) {
      params.approvalPolicy = mapPermissionMode(options.permissionMode);
      params.sandbox = mapSandboxMode(options.permissionMode);
    }
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      // Only forward serializable MCP configs (stdio/SSE with command/args).
      // In-process server instances (McpSdkServerConfigWithInstance from Claude SDK)
      // contain Zod schemas with circular references and can't be JSON.stringify'd.
      const serializableServers: Record<string, unknown> = {};
      for (const [name, config] of Object.entries(options.mcpServers)) {
        if (config && typeof config === 'object' && 'type' in config && (config as Record<string, unknown>).type === 'stdio') {
          serializableServers[name] = config;
        }
      }
      if (Object.keys(serializableServers).length > 0) {
        params.config = { mcp_servers: serializableServers };
      }
    }
    if (options.systemPrompt) {
      params.developerInstructions = options.systemPrompt;
    }

    return params;
  }

  private applySettings(settings: TurnSettings): void {
    if (settings.model !== undefined) {
      this._settings = { ...this._settings, model: settings.model };
    }
    if (settings.permissionMode !== undefined) {
      this._settings = { ...this._settings, permissionMode: settings.permissionMode };
    }
    if (settings.allowDangerouslySkipPermissions !== undefined) {
      this._settings = {
        ...this._settings,
        allowDangerouslySkipPermissions: settings.allowDangerouslySkipPermissions,
      };
    }
    if (settings.extraArgs !== undefined) {
      this._settings = { ...this._settings, extraArgs: settings.extraArgs };
    }
    if (settings.outputFormat !== undefined) {
      this._outputFormat = settings.outputFormat;
    }
  }

  // --- Private: Notification Handling ---

  private handleNotification(method: string, params: unknown): void {
    // Skip legacy codex/event/* notifications
    if (method.startsWith('codex/event/')) return;

    const p = params as Record<string, unknown>;

    switch (method) {
      case 'turn/started': {
        const turn = p.turn as Record<string, unknown> | undefined;
        this.currentTurnId = turn?.id as string | undefined;
        this.startupPhase = false;
        // Reset item tracking + streaming buffer for new turn
        this.pendingItemCount = 0;
        this.turnCompletedPending = false;
        this.clearTurnCompleteSafetyTimer();
        this.streamingText = '';
        this.streamingThinking = '';
        this.emitStatus('active');
        break;
      }

      case 'turn/completed': {
        this.clearStreamingBuffer();
        this.currentTurnId = undefined;
        // Codex delivers item/completed events AFTER turn/completed, often in
        // a separate event loop tick. If items are still pending, defer the
        // idle signal until all item/completed events arrive — then emit with
        // turnComplete so dispatch resolves immediately without debounce.
        if (this.pendingApprovals.size === 0) {
          if (this.pendingItemCount > 0) {
            this.turnCompletedPending = true;
            this.startTurnCompleteSafetyTimer();
            log({ level: 'debug', source: 'codex-adapter', summary: `turn/completed deferred — ${this.pendingItemCount} item(s) still pending` });
          } else {
            // All items already delivered — safe to emit turnComplete now
            this.turnCompletedPending = false;
            this.emitIdleWithTurnComplete();
          }
        } else {
          // Turn ended while approvals pending — record that fact.
          // respondToApproval() will handle idle emission when approvals clear.
          this.turnCompletedPending = true;
          this.startTurnCompleteSafetyTimer();
        }
        break;
      }

      case 'item/completed': {
        const item = (p.item ?? p) as ThreadItem;
        const threadId = (p.threadId as string) ?? this.currentThreadId ?? '';
        const turnId = (p.turnId as string) ?? this.currentTurnId ?? '';

        // --- userMessage handling: startup-phase detection + echo suppression ---
        if (item.type === 'userMessage') {
          // During startup (before first turn/started), Codex may inject
          // system-context items (AGENTS.md, environment_context) as userMessages,
          // or replay history echoes during thread/resume or thread/fork.
          // Mark them isMeta so rendering and serialization skip them.
          //
          // IMPORTANT: startupPhase must be checked BEFORE echo suppression.
          // sendTurn() increments pendingSendCount before start(), so during
          // fork startup the counter is >0. Without this guard, the first
          // replayed userMessage would be consumed by echo suppression instead
          // of being tagged isMeta, and the actual echo after turn/started
          // would pass through as a duplicate.
          if (this.startupPhase) {
            try {
              const entries = adaptCodexItem(item, threadId, turnId);
              for (const entry of entries) {
                entry.isMeta = true;
                this.outputQueue.enqueue({ type: 'entry', entry });
              }
            } catch (err) {
              log({ level: 'warn', source: 'codex-adapter', summary: `Failed to adapt startup item: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
            }
            this.settleItemTracking();
            break;
          }

          // Echo suppression: skip userMessage items that we sent — the channel
          // already broadcast the optimistic user entry from sendTurn().
          if (this.pendingSendCount > 0) {
            this.pendingSendCount--;
            this.settleItemTracking();
            break;
          }
        }

        try {
          const entries = adaptCodexItem(item, threadId, turnId);
          for (const entry of entries) {
            // Inject context usage into assistant entries only when the adapter
            // has a trustworthy occupancy snapshot.
            if (entry.type === 'assistant' && this._contextUsage && entry.message) {
              entry.message.usage = {
                input_tokens: this._contextUsage.tokens.input,
                output_tokens: this._contextUsage.tokens.output,
                cache_creation_input_tokens: this._contextUsage.tokens.cacheCreation,
                cache_read_input_tokens: this._contextUsage.tokens.cacheRead,
              };
            }
            this.outputQueue.enqueue({ type: 'entry', entry });
          }
        } catch (err) {
          log({ level: 'warn', source: 'codex-adapter', summary: `Failed to adapt item: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
        }

        // Clear streaming ghost when a complete assistant message arrives
        // (emit entry first so the webview has it before the ghost clears)
        if (item.type === 'agentMessage') {
          this.clearStreamingBuffer();
        }

        this.settleItemTracking();
        break;
      }

      case 'item/agentMessage/delta': {
        const delta = (p.delta as string) ?? '';
        this.streamingText += delta;
        this.scheduleStreamingEmit();
        break;
      }

      case 'item/reasoning/summaryTextDelta': {
        const delta = (p.delta as string) ?? '';
        this.streamingThinking += delta;
        this.scheduleStreamingEmit();
        break;
      }

      case 'thread/tokenUsage/updated': {
        const tokenUsage = p.tokenUsage as Record<string, unknown> | undefined;
        if (tokenUsage) {
          this._contextUsage = mapTokenUsage(tokenUsage);
          // Note: Do NOT emit settings_changed — contextUsage is read from
          // the adapter property by the channel, not pushed as an event.
        }
        break;
      }

      case 'thread/started': {
        const thread = p.thread as Record<string, unknown> | undefined;
        const newId = (thread?.id ?? p.threadId) as string | undefined;
        if (newId && newId !== this._sessionId) {
          const prev = this._sessionId;
          this._sessionId = newId;
          this.currentThreadId = newId;
          this.outputQueue.enqueue({
            type: 'event',
            event: {
              type: 'notification',
              kind: 'session_changed',
              sessionId: newId,
              ...(prev ? { previousSessionId: prev } : {}),
            },
          });
        }
        break;
      }

      case 'thread/compacted': {
        this.outputQueue.enqueue({
          type: 'event',
          event: { type: 'notification', kind: 'compacting' },
        });
        break;
      }

      case 'skills/changed': {
        this.bundledSkillDiscoveryGeneration += 1;
        this.bundledSkillDiscoveryNeedsReload = true;
        break;
      }

      case 'error': {
        const msg = (p.message ?? p.error ?? 'Unknown error') as string;
        this.emitError(msg);
        break;
      }

      case 'item/started':
        this.pendingItemCount++;
        break;

      // Ignored notifications
      case 'item/reasoning/summaryPartAdded':
      case 'account/rateLimits/updated':
        // These are informational, don't need to emit events
        break;

      default:
        // Log unknown notifications in debug mode
        // console.debug('[codex-adapter] Unknown notification:', method);
        break;
    }
  }

  // --- Private: Server Request Handling (Approvals) ---

  private handleServerRequest(
    method: string,
    id: number | string,
    params: unknown,
  ): void {
    if (!isApprovalRequest(method)) {
      log({ level: 'warn', source: 'codex-adapter', summary: `Unknown server request: ${method}`, data: { method, id } });
      // Respond with a decline decision — if this is an unrecognized approval
      // method, sending { error } may leave Codex hanging because it expects a
      // decision-shaped response. A decline is safe: the turn continues and the
      // user sees the denial in the transcript.
      try {
        this.client?.sendResponse(id, { decision: 'decline' });
      } catch { /* cleanup */ }
      return;
    }

    const p = params as Record<string, unknown>;
    const mapped = codexApprovalToEvent(method, p);

    if (!mapped) {
      log({ level: 'warn', source: 'codex-adapter', summary: `Failed to map approval request: ${method}` });
      try {
        this.client?.sendResponse(id, { decision: 'deny' });
      } catch { /* cleanup — don't throw */ }
      return;
    }

    // Store pending approval
    this.pendingApprovals.set(mapped.toolUseId, {
      serverRequestId: id,
      method,
      amendment: mapped.proposedAmendment,
    });

    // Emit awaiting approval event
    this._status = 'awaiting_approval';
    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'status',
        status: 'awaiting_approval',
        toolUseId: mapped.toolUseId,
        toolName: mapped.toolName,
        input: mapped.input,
        reason: mapped.reason,
        options: mapped.options,
      },
    });
  }

  // --- Private: Process Lifecycle ---

  private handleProcessExit(code: number | null, signal: string | null): void {
    log({ level: 'debug', source: 'codex-adapter', summary: `Process exited: code=${code}, signal=${signal}` });

    // Emit error if unexpected exit
    if (!this._closed && (code !== 0 && code !== null)) {
      this.emitError(`Process exited unexpectedly: code=${code}, signal=${signal}`);
    }

    // Clean up
    this.client = null;
    this.startPromise = null;

    if (!this._closed) {
      this.emitStatus('idle');
    }
  }

  // --- Private: Streaming Emission ---

  /** Schedule a throttled streaming_content emission (~60fps). */
  private scheduleStreamingEmit(): void {
    if (this.streamingEmitTimer !== null) return;
    this.streamingEmitTimer = setTimeout(() => {
      this.streamingEmitTimer = null;
      this.flushStreamingEmit();
    }, CodexAgentAdapter.STREAMING_EMIT_INTERVAL);
  }

  /** Emit a snapshot of current accumulated streaming content. */
  private flushStreamingEmit(): void {
    if (this.streamingEmitTimer !== null) {
      clearTimeout(this.streamingEmitTimer);
      this.streamingEmitTimer = null;
    }

    const content: ContentBlock[] = [];
    if (this.streamingThinking) {
      content.push({ type: 'thinking', thinking: this.streamingThinking });
    }
    if (this.streamingText) {
      content.push({ type: 'text', text: this.streamingText });
    }
    if (content.length === 0) return;

    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'streaming_content',
        content,
      } as unknown as ChannelEvent,
    });
  }

  /** Clear the streaming buffer and emit a clear signal to the webview. */
  private clearStreamingBuffer(): void {
    if (this.streamingEmitTimer !== null) {
      clearTimeout(this.streamingEmitTimer);
      this.streamingEmitTimer = null;
    }

    const wasStreaming = this.streamingText.length > 0 || this.streamingThinking.length > 0;
    this.streamingText = '';
    this.streamingThinking = '';

    if (!wasStreaming) return;

    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'streaming_content',
        content: null,
      } as unknown as ChannelEvent,
    });
  }

  // --- Private: Event Emitters ---

  private emitStatus(status: 'idle' | 'active'): void {
    if (this._closed) return;
    this._status = status;
    this.outputQueue.enqueue({
      type: 'event',
      event: { type: 'status', status },
    });
  }

  /** Decrement pending item count and resolve deferred turn/completed if all items delivered. */
  private settleItemTracking(): void {
    if (this.pendingItemCount > 0) this.pendingItemCount--;
    if (this.turnCompletedPending && this.pendingItemCount === 0) {
      this.turnCompletedPending = false;
      this.clearTurnCompleteSafetyTimer();
      log({ level: 'debug', source: 'codex-adapter', summary: 'All pending items delivered after turn/completed — emitting idle+turnComplete' });
      this.emitIdleWithTurnComplete();
    }
  }

  /** Emit idle with authoritative turnComplete — skips debounce in dispatch. */
  private emitIdleWithTurnComplete(): void {
    if (this._closed) return;
    this.clearTurnCompleteSafetyTimer();
    this._status = 'idle';
    this.outputQueue.enqueue({
      type: 'event',
      event: { type: 'status', status: 'idle', turnComplete: true },
    });
  }

  /** Start safety timeout for stuck pendingItemCount — emits plain idle after 10s. */
  private startTurnCompleteSafetyTimer(): void {
    this.clearTurnCompleteSafetyTimer();
    this.turnCompleteSafetyTimer = setTimeout(() => {
      if (this.turnCompletedPending) {
        log({
          level: 'warn',
          source: 'codex-adapter',
          summary: `Safety timeout: ${this.pendingItemCount} item(s) never settled — emitting idle`,
        });
        this.turnCompletedPending = false;
        this.pendingItemCount = 0;
        this.emitStatus('idle');
      }
    }, 10_000);
  }

  /** Clear the turn-complete safety timer. */
  private clearTurnCompleteSafetyTimer(): void {
    if (this.turnCompleteSafetyTimer !== null) {
      clearTimeout(this.turnCompleteSafetyTimer);
      this.turnCompleteSafetyTimer = null;
    }
  }

  private emitError(error: Error | string): void {
    if (this._closed) return;
    log({
      source: 'session',
      level: 'error',
      summary: `Adapter: error (${this._sessionId?.slice(0, 12) ?? 'unknown'}…)`,
      data: { sessionId: this._sessionId, error: typeof error === 'string' ? error : error.message },
    });
    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'error',
        error: typeof error === 'string' ? error : error.message,
      },
    });
  }

  private emitSettingsChanged(): void {
    if (this._closed) return;
    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'settings_changed',
        settings: this._settings,
      },
    });
  }
}
