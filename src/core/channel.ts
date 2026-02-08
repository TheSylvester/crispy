/**
 * Channel Interface
 *
 * The unified contract for a conversation channel. Combines the transcript
 * entry stream (conversation content) with the channel event stream
 * (status transitions, notifications) into a single interface.
 *
 * Adapters implement this interface. Consumers import from here — not from
 * transcript.ts or channel-events.ts directly.
 *
 * A channel is a stable pipe that outlives individual vendor sessions.
 * Internally, vendor sessions (e.g. SDK query() calls) are created and
 * destroyed, but the channel identity persists. Subscribers never lose
 * their connection.
 *
 * @module channel
 */

// Re-export everything consumers need from a single import
export type {
  TranscriptEntry,
  TranscriptMessage,
  EntryType,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  MessageContent,
  MessageContentBlock,
  ToolName,
  ToolInput,
  ToolResult,
  ToolCategory,
  Usage,
  Vendor,
} from './transcript.js';

export type {
  ChannelEvent,
  ChannelStatus,
  StatusEvent,
  NotificationEvent,
  IdleEvent,
  ActiveEvent,
  AwaitingApprovalEvent,
  ApprovalOption,
  ErrorEvent,
  CompactingEvent,
  PermissionModeChangedEvent,
  SessionChangedEvent,
} from './channel-events.js';

export { resolveToolCategory, CLAUDE_TOOL_CATEGORIES } from './transcript.js';

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

/** Union of everything the channel output stream yields. */
export type ChannelMessage = EntryMessage | EventMessage;

// ============================================================================
// Channel Interface
// ============================================================================

/**
 * A conversation channel — the stable pipe between a consumer and a
 * vendor's AI agent.
 *
 * The channel manages the full lifecycle: sending messages, receiving
 * transcript entries and events, responding to approval requests, and
 * handling session transitions.
 */
export interface Channel {
  /** The vendor this channel connects to. */
  readonly vendor: Vendor;

  /** Current session ID. Changes when a new session starts. */
  readonly sessionId: string | undefined;

  /** Current channel status (synchronous read of last sticky status). */
  readonly status: ChannelStatus;

  /**
   * The combined output stream.
   *
   * Yields transcript entries and channel events interleaved in order.
   * Consumers can discriminate on `message.type` to filter.
   *
   * This async iterable remains open for the lifetime of the channel,
   * spanning multiple vendor sessions.
   *
   * **Single-consumer.** The returned iterable can only be iterated once.
   * If multiple consumers are needed, implement a fan-out on top.
   */
  messages(): AsyncIterable<ChannelMessage>;

  /**
   * Send a user message into the channel.
   *
   * If no vendor session is active, one is created. If a session is
   * already running, the message is enqueued into the existing session.
   *
   * Throws if the channel is closed or awaiting approval.
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
   * Close the channel and tear down any active vendor session.
   *
   * After closing, the output stream completes and no further messages
   * can be sent.
   */
  close(): void;
}
