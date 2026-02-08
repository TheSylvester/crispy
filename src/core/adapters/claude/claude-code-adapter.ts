/**
 * Claude Agent SDK → Channel Adapter
 *
 * Implements the Channel interface for Claude Code via the Agent SDK.
 * Manages the full lifecycle: input queue, query() calls, SDKMessage
 * mapping, permission handling, and session transitions.
 *
 * @module claude-code-adapter
 */

import type {
  Channel,
  ChannelMessage,
  MessageContent,
} from '../../channel.js';
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

// ============================================================================
// Configuration
// ============================================================================

/** Options for creating a ClaudeCodeChannel. */
export interface ClaudeCodeChannelOptions {
  /** Session ID to resume. Omit to start a new session. */
  resumeSessionId?: string;
  /** Working directory for the session. */
  cwd?: string;
  /** Model to use (e.g. 'sonnet', 'opus'). */
  model?: string;
  /** Initial permission mode. */
  permissionMode?: PermissionMode;
  /** Additional SDK options passed through to query(). */
  sdkOptions?: Partial<Options>;
}

// ============================================================================
// Pending Approval
// ============================================================================

interface PendingApproval {
  toolUseId: string;
  resolve: (result: PermissionResult) => void;
  suggestions?: PermissionUpdate[];
  /** Valid option IDs for this approval request. */
  validOptionIds: string[];
}

// ============================================================================
// ClaudeCodeChannel
// ============================================================================

export class ClaudeCodeChannel implements Channel {
  readonly vendor = 'claude';

  private _sessionId: string | undefined;
  private _status: ChannelStatus = 'idle';
  private _closed = false;

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

  private readonly options: ClaudeCodeChannelOptions;

  constructor(options: ClaudeCodeChannelOptions = {}) {
    this.options = options;
    this._sessionId = options.resumeSessionId;
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

  send(content: MessageContent): void {
    if (this._closed) {
      throw new Error('Channel is closed');
    }
    if (this._status === 'awaiting_approval') {
      throw new Error('Cannot send while awaiting approval');
    }

    const sdkMessage = this.toSDKUserMessage(content);

    if (!this.activeQuery || !this.inputQueue) {
      // No active session — spin up a new query()
      this.startQuery(sdkMessage);
    } else {
      // Session is running — enqueue into existing input queue
      this.inputQueue.enqueue(sdkMessage);
    }
  }

  respondToApproval(toolUseId: string, optionId: string): void {
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
      result = { behavior: 'deny', message: 'User denied', toolUseID: toolUseId };
    } else {
      // 'allow', 'allow_session', etc. — all resolve as allow.
      // If the option was 'allow_session' and there are suggestions,
      // pass them through as updatedPermissions so the SDK persists them.
      result = {
        behavior: 'allow',
        toolUseID: toolUseId,
        ...(optionId !== 'allow' && pending.suggestions
          ? { updatedPermissions: pending.suggestions }
          : {}),
      };
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
  // Query lifecycle
  // --------------------------------------------------------------------------

  private startQuery(firstMessage: SDKUserMessage): void {
    this.inputQueue = new AsyncIterableQueue<SDKUserMessage>();
    this.inputQueue.enqueue(firstMessage);

    this.abortController = new AbortController();

    // Adapter invariants (abortController, includePartialMessages, canUseTool)
    // are applied AFTER the user's sdkOptions spread so they cannot be overridden.
    const sdkOptions: Options = {
      ...this.options.sdkOptions,
      ...(this.options.cwd && { cwd: this.options.cwd }),
      ...(this.options.model && { model: this.options.model }),
      ...(this.options.permissionMode && { permissionMode: this.options.permissionMode }),
      ...(this._sessionId && { resume: this._sessionId }),
      // Adapter invariants — must not be overridden by sdkOptions
      abortController: this.abortController,
      includePartialMessages: true,
      canUseTool: (toolName, input, opts) => this.handleCanUseTool(toolName, input, opts),
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
    if (this._status !== 'active') this.emitStatus('active');
    this.emitEntry(msg);
  }

  private handleUserMessage(msg: SDKUserMessage): void {
    // Skip replayed messages (they're history, not new content)
    if ('isReplay' in msg && (msg as { isReplay?: boolean }).isReplay) return;
    this.emitEntry(msg);
  }

  private handleResultMessage(msg: SDKResultMessage): void {
    this.emitEntry(msg);
  }

  private handleSystemMessage(msg: SDKMessage): void {
    const systemMsg = msg as SDKSystemMessage | SDKStatusMessage | SDKCompactBoundaryMessage;

    if (!('subtype' in systemMsg)) {
      // System message without subtype — pass through as entry
      this.emitEntry(msg);
      return;
    }

    switch (systemMsg.subtype) {
      case 'init':
        // System init — emit as entry for metadata (tools, model, etc.)
        this.emitEntry(msg);
        break;

      case 'status': {
        const statusMsg = systemMsg as SDKStatusMessage;
        if (statusMsg.status === 'compacting') {
          this.outputQueue.enqueue({
            type: 'event',
            event: { type: 'notification', kind: 'compacting' },
          });
        }
        if (statusMsg.permissionMode) {
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

      // Store the pending approval
      this.pendingApprovals.set(toolUseId, {
        toolUseId,
        resolve,
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
