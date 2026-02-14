/**
 * Agent Adapter Interface
 *
 * The single interface for vendor adapters. Combines live session streaming
 * (send, messages, approval handling, close) with session discovery and
 * history loading. Each vendor adapter (Claude, Codex, Gemini) implements
 * this to provide a uniform shape for the Session Channel.
 *
 * Also defines the ChannelMessage discriminated union — the combined output
 * stream type yielded by messages().
 *
 * @module agent-adapter
 */

import type { TranscriptEntry, MessageContent, Vendor, ContextUsage } from './transcript.js';
import type { ChannelEvent, ChannelStatus } from './channel-events.js';

// ============================================================================
// Channel Message — the combined output stream type
// ============================================================================

/** A transcript entry flowing through the channel. */
export interface EntryMessage {
  type: 'entry';
  entry: TranscriptEntry;
}

/** A channel event (status change or notification). */
export interface EventMessage {
  type: 'event';
  event: ChannelEvent;
}

/** Union of everything the adapter output stream yields. */
export type ChannelMessage = EntryMessage | EventMessage;

// ============================================================================
// Session Info — vendor-agnostic session metadata
// ============================================================================

/**
 * Metadata about a saved session on disk.
 *
 * Widened from the Claude-specific SessionInfo (which has `vendor: 'claude'`)
 * to accept any Vendor. Claude's literal type is assignable to this.
 */
export interface SessionInfo {
  sessionId: string;
  path: string;
  projectSlug: string;
  modifiedAt: Date;
  size: number;
  label?: string;
  lastMessage?: string;
  vendor: Vendor;
}

// ============================================================================
// Vendor Discovery — stateless session operations
// ============================================================================

/**
 * Static discovery operations for a vendor.
 *
 * Separate from AgentAdapter because discovery is stateless — it reads
 * session metadata from disk without needing a live SDK connection.
 * One VendorDiscovery per vendor, shared across all consumers.
 */
export interface VendorDiscovery {
  readonly vendor: Vendor;
  findSession(sessionId: string): SessionInfo | undefined;
  listSessions(): SessionInfo[];
  loadHistory(sessionId: string): Promise<TranscriptEntry[]>;
}

// ============================================================================
// Send Options — bundled with each send() call
// ============================================================================

/**
 * Options passed alongside the user's message at send time.
 *
 * Matches Leto's SendOptions — the control panel gathers UI state and
 * bundles it into a single object so the adapter can apply everything
 * atomically before starting a new query.
 */
export interface SendOptions {
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  allowDangerouslySkipPermissions?: boolean;
}

/**
 * Discriminated union describing how to open a session.
 *
 * 'resume'   — reattach to an existing session by ID (current behavior)
 * 'fresh'    — start a brand-new session (no resume ID)
 * 'fork'     — fork from an existing session (future)
 * 'continue' — continue the most recent session in a CWD (future)
 */
export type SessionOpenSpec =
  | { mode: 'resume'; sessionId: string }
  | { mode: 'fresh'; cwd: string; model?: string; permissionMode?: SendOptions['permissionMode']; extraArgs?: Record<string, string | null> }
  | { mode: 'fork'; fromSessionId: string; atMessageId?: string }
  | { mode: 'continue'; sessionId: string };

// ============================================================================
// Agent Adapter Interface
// ============================================================================

/**
 * A per-session live adapter — streaming, input, controls.
 *
 * Each live session gets its own AgentAdapter instance from the vendor's
 * factory. The Session Channel owns one AgentAdapter and uses it for
 * live streaming (via messages/send/respondToApproval/close) and
 * mid-session controls (setModel, interrupt, etc.).
 *
 * Live controls are best-effort. If a vendor doesn't support mid-stream
 * model switching, the call can throw or no-op. Promoting them to the
 * interface means the Session Channel and UI can attempt them uniformly
 * without downcasting to vendor-specific types.
 */
export interface AgentAdapter {
  /** The vendor this adapter connects to. */
  readonly vendor: Vendor;

  /** Current session ID. Changes when a new session starts. */
  readonly sessionId: string | undefined;

  /** Current channel status (synchronous read of last sticky status). */
  readonly status: ChannelStatus;

  /** Cumulative context window usage for the active session (null before first assistant turn). */
  readonly contextUsage: ContextUsage | null;

  // --- Live Streaming ---

  /**
   * The combined output stream.
   *
   * Yields transcript entries and channel events interleaved in order.
   * Consumers can discriminate on `message.type` to filter.
   *
   * This async iterable remains open for the lifetime of the adapter,
   * spanning multiple vendor sessions.
   *
   * **Single-consumer.** The returned iterable can only be iterated once.
   * If multiple consumers are needed, implement a fan-out on top.
   */
  messages(): AsyncIterable<ChannelMessage>;

  /**
   * Send a user message into the adapter.
   *
   * If no vendor session is active, one is created. If a session is
   * already running, the message is enqueued into the existing session.
   *
   * Options (model, permissionMode, etc.) are applied atomically before
   * the query starts — they're bundled with the message like Leto does.
   * When a session is already running, options are applied mid-stream
   * (best-effort).
   *
   * Throws if the adapter is closed or awaiting approval.
   * Errors from the underlying vendor session are delivered via the
   * event stream, not thrown from this method.
   */
  send(content: MessageContent, options?: SendOptions): void;

  /**
   * Respond to a pending approval request.
   *
   * @param toolUseId - The tool_use block ID from the AwaitingApprovalEvent
   * @param optionId - The `id` of the chosen ApprovalOption
   * @param extra - Optional structured data (form answers, mode changes, deny message)
   */
  respondToApproval(toolUseId: string, optionId: string, extra?: {
    message?: string;
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: unknown[];
  }): void;

  /**
   * Close the adapter and tear down any active vendor session.
   *
   * After closing, the output stream completes and no further messages
   * can be sent.
   */
  close(): void;

  // --- Live Session Controls ---

  /**
   * Interrupt the active session (pause, not kill).
   * Throws if no session is active.
   */
  interrupt(): Promise<void>;

  /**
   * Change the model mid-conversation.
   * Vendors that don't support this should throw with a descriptive message.
   */
  setModel(model?: string): Promise<void>;

  /**
   * Change the permission mode mid-conversation.
   * Vendors that don't support this should throw with a descriptive message.
   */
  setPermissionMode(mode: string): Promise<void>;

  /**
   * Tear down the current query and update options that require a fresh
   * query() call (e.g. allowDangerouslySkipPermissions, extraArgs).
   * The next send() will create a new query with the updated options.
   * Only callable when idle. Vendors that don't support this can omit it.
   */
  prepareQueryRestart?(updates: {
    allowDangerouslySkipPermissions?: boolean;
    extraArgs?: Record<string, string | null>;
  }): void;
}
