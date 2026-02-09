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

import type { TranscriptEntry, MessageContent, Vendor } from './transcript.js';
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
  vendor: Vendor;
}

// ============================================================================
// Agent Adapter Interface
// ============================================================================

/**
 * A vendor adapter — the single interface for live streaming, history,
 * discovery, and live controls.
 *
 * The Session Channel owns one AgentAdapter and uses it for both live
 * streaming (via messages/send/respondToApproval/close) and loading past
 * sessions from disk.
 *
 * Live controls (setModel, interrupt, etc.) are best-effort. If a vendor
 * doesn't support mid-stream model switching, the call can throw or no-op.
 * Promoting them to the interface means the Session Channel and UI can
 * attempt them uniformly without downcasting to vendor-specific types.
 */
export interface AgentAdapter {
  /** The vendor this adapter connects to. */
  readonly vendor: Vendor;

  /** Current session ID. Changes when a new session starts. */
  readonly sessionId: string | undefined;

  /** Current channel status (synchronous read of last sticky status). */
  readonly status: ChannelStatus;

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
   * Throws if the adapter is closed or awaiting approval.
   * Errors from the underlying vendor session are delivered via the
   * event stream, not thrown from this method.
   */
  send(content: MessageContent): void;

  /**
   * Respond to a pending approval request.
   *
   * @param toolUseId - The tool_use block ID from the AwaitingApprovalEvent
   * @param optionId - The `id` of the chosen ApprovalOption
   */
  respondToApproval(toolUseId: string, optionId: string): void;

  /**
   * Close the adapter and tear down any active vendor session.
   *
   * After closing, the output stream completes and no further messages
   * can be sent.
   */
  close(): void;

  // --- History / Discovery ---

  /** Load transcript entries from a saved session by ID. */
  loadHistory(sessionId: string): Promise<TranscriptEntry[]>;

  /** Find a session by ID across all known projects. */
  findSession(sessionId: string): SessionInfo | undefined;

  /** List all known sessions, most recently modified first. */
  listSessions(): SessionInfo[];

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
}
