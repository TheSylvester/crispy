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

import type {
  AgentAdapter,
  ChannelMessage,
  SessionOpenSpec,
  AdapterSettings,
  TurnSettings,
} from '../../agent-adapter.js';
import type { ChannelEvent, ChannelStatus } from '../../channel-events.js';
import type {
  ContentBlock,
  ContextUsage,
  MessageContent,
  Vendor,
} from '../../transcript.js';
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
  mapThreadConfig,
  mapTokenUsage,
  mapMessageContent,
  mapTurnSettings,
} from './codex-settings-mapping.js';
import { codexDiscovery } from './codex-discovery.js';
import type { ThreadItem } from './protocol/v2/ThreadItem.js';

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

  // --- Streaming delta accumulator ---
  /** Accumulated text from agentMessage deltas for the current turn. */
  private streamingText = '';
  /** Accumulated thinking text from reasoning deltas for the current turn. */
  private streamingThinking = '';
  /** Throttle timer for streaming_content emission. */
  private streamingEmitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Minimum interval between streaming_content emissions (ms). */
  private static readonly STREAMING_EMIT_INTERVAL = 16; // ~60fps
  private readonly spec: SessionOpenSpec & { cwd?: string; command?: string; args?: string[] };

  constructor(spec: SessionOpenSpec & { cwd?: string; command?: string; args?: string[] }) {
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
      console.error('[codex-adapter] Failed to send approval response:', err);
    }

    // Transition back to active if no more pending approvals
    if (this.pendingApprovals.size === 0) {
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

    // Clear streaming buffer before closing
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
      console.error('[codex-adapter] Interrupt failed:', err);
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

    // Create RPC client
    this.client = new CodexRpcClient({
      ...(this.spec.command && { command: this.spec.command }),
      ...(this.spec.args && { args: this.spec.args }),
      cwd: (this.spec.mode === 'fresh' || this.spec.mode === 'hydrated') ? this.spec.cwd : undefined,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, id, params) => this.handleServerRequest(method, id, params),
      onError: (err) => this.emitError(err),
      onExit: (code, signal) => this.handleProcessExit(code, signal),
    });

    // Initialize protocol
    await this.client.request('initialize', {
      clientInfo: { name: 'crispy', version: '0.1.4-dev.36' },
      capabilities: { experimentalApi: true },
    });

    // Start/resume/fork thread based on spec
    let response: Record<string, unknown>;

    switch (this.spec.mode) {
      case 'fresh': {
        const params: Record<string, unknown> = {
          cwd: this.spec.cwd,
        };
        if (this.spec.model) params.model = this.spec.model;
        if (this.spec.permissionMode) {
          params.approvalPolicy = mapPermissionMode(this.spec.permissionMode);
        }

        response = await this.client.request('thread/start', params);
        break;
      }

      case 'resume': {
        response = await this.client.request('thread/resume', {
          threadId: this.spec.sessionId,
        });
        break;
      }

      case 'fork': {
        const forkParams: Record<string, unknown> = {
          threadId: this.spec.fromSessionId,
        };
        if (this.spec.atMessageId) {
          forkParams.atItemId = this.spec.atMessageId;
        }
        response = await this.client.request('thread/fork', forkParams);
        break;
      }

      case 'hydrated': {
        const history = serializeToCodexHistory(this.spec.history);
        response = await this.client.request('thread/resume', {
          threadId: crypto.randomUUID(),
          history,
          cwd: this.spec.cwd,
          ...(this.spec.model && { model: this.spec.model }),
          ...(this.spec.permissionMode && { approvalPolicy: mapPermissionMode(this.spec.permissionMode) }),
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
    const newSettings = mapThreadConfig(response);
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

    const input = mapMessageContent(content);
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
        // Reset streaming buffer for new turn (no clear event — fresh turn)
        this.streamingText = '';
        this.streamingThinking = '';
        this.emitStatus('active');
        break;
      }

      case 'turn/completed': {
        this.clearStreamingBuffer();
        this.currentTurnId = undefined;
        // Only transition to idle if no pending approvals
        if (this.pendingApprovals.size === 0) {
          this.emitStatus('idle');
        }
        break;
      }

      case 'item/completed': {
        const item = (p.item ?? p) as ThreadItem;
        const threadId = (p.threadId as string) ?? this.currentThreadId ?? '';
        const turnId = (p.turnId as string) ?? this.currentTurnId ?? '';

        // --- userMessage handling: echo suppression + system-context detection ---
        if (item.type === 'userMessage') {
          // Echo suppression: skip userMessage items that we sent — the channel
          // already broadcast the optimistic user entry from sendTurn().
          if (this.pendingSendCount > 0) {
            this.pendingSendCount--;
            break;
          }

          // During startup (before first turn/started), Codex may inject
          // system-context items (AGENTS.md, environment_context) as userMessages.
          // Mark them isMeta so rendering and serialization skip them.
          // Also catches history echoes during thread/resume — the session-manager
          // already backfilled history, so these are duplicates.
          if (this.startupPhase) {
            try {
              const entries = adaptCodexItem(item, threadId, turnId);
              for (const entry of entries) {
                entry.isMeta = true;
                this.outputQueue.enqueue({ type: 'entry', entry });
              }
            } catch (err) {
              console.warn('[codex-adapter] Failed to adapt startup item:', err);
            }
            break;
          }
        }

        try {
          const entries = adaptCodexItem(item, threadId, turnId);
          for (const entry of entries) {
            // Inject context usage into assistant entries so the webview gauge
            // can compute usage from entries (same pattern Claude SDK uses).
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
          console.warn('[codex-adapter] Failed to adapt item:', err);
        }

        // Clear streaming ghost when a complete assistant message arrives
        // (emit entry first so the webview has it before the ghost clears)
        if (item.type === 'agentMessage') {
          this.clearStreamingBuffer();
        }
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

      case 'error': {
        const msg = (p.message ?? p.error ?? 'Unknown error') as string;
        this.emitError(msg);
        break;
      }

      // Ignored notifications
      case 'item/started':
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
      console.warn('[codex-adapter] Unknown server request:', method);
      try {
        this.client?.sendResponse(id, { error: 'Unknown method' });
      } catch { /* cleanup */ }
      return;
    }

    const p = params as Record<string, unknown>;
    const mapped = codexApprovalToEvent(method, p);

    if (!mapped) {
      console.warn('[codex-adapter] Failed to map approval request:', method);
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
    console.log(`[codex-adapter] Process exited: code=${code}, signal=${signal}`);

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

  private emitError(error: Error | string): void {
    if (this._closed) return;
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
