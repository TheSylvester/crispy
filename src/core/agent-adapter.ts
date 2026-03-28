/**
 * Agent Adapter Interface
 *
 * The single interface for vendor adapters. Combines live session streaming
 * (sendTurn, messages, approval handling, close) with session discovery and
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
  /** Real absolute path to the project directory (e.g. "/home/user/my-project"). */
  projectPath?: string;
  modifiedAt: Date;
  size: number;
  label?: string;
  lastMessage?: string;
  lastUserPrompt?: string;
  vendor: Vendor;
  isSidechain?: boolean;
  /** Short session title from the session_titles table. */
  title?: string;
  /** 'user' = user-initiated session, 'system' = internal (Rosie, etc). */
  sessionKind?: 'user' | 'system';
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
/** Result from incremental sub-agent entry reading. */
export interface SubagentEntriesResult {
  entries: TranscriptEntry[];
  cursor: string;   // opaque resumption token — vendor-specific format
  done: boolean;
}

/** User prompt metadata extracted during activity scanning. */
export interface UserPromptInfo {
  timestamp: string;
  preview: string;
  offset: number;
  uuid?: string;
}

/** Result from scanning user activity in a session file. */
export interface UserActivityScanResult {
  prompts: UserPromptInfo[];
  offset: number;
}

export interface VendorDiscovery {
  readonly vendor: Vendor;
  findSession(sessionId: string): SessionInfo | undefined;
  listSessions(): SessionInfo[];
  loadHistory(sessionId: string): Promise<TranscriptEntry[]>;

  /**
   * Read sub-agent transcript entries incrementally.
   *
   * Optional — vendors that don't support background sub-agents omit this.
   * The cursor is an opaque string returned by the previous call (empty = start).
   * The caller passes it back without interpreting it.
   */
  readSubagentEntries?(
    sessionId: string,
    agentId: string,
    parentToolUseId: string,
    cursor: string,
  ): SubagentEntriesResult;

  /**
   * Pre-materialize a fork on disk, returning a real session ID.
   *
   * Optional — vendors that support SDK-level forking (e.g. Claude 0.2.76+)
   * implement this so session-manager can skip the pending→real ID re-key dance.
   * The returned sessionId is immediately usable as a resume target.
   */
  preFork?(sessionId: string, options?: { atMessageId?: string; dir?: string }): Promise<{ sessionId: string }>;

  /**
   * Scan user activity (prompts) in a session file incrementally.
   *
   * Optional — vendors that don't support activity scanning omit this.
   * The offset is a byte offset into the JSONL file; pass the returned
   * offset on the next call to continue scanning from where you left off.
   *
   * @param sessionPath - Absolute path to the session JSONL file
   * @param fromOffset - Byte offset to start scanning from (default 0)
   */
  scanUserActivity?(sessionPath: string, fromOffset?: number): UserActivityScanResult;
}

// ============================================================================
// Turn Intent Types — unified send surface
// ============================================================================

/**
 * Settings bundled with a turn (user message).
 *
 * These are applied atomically when the turn is sent:
 * - model, permissionMode: live-changeable (applied mid-stream if query active)
 * - allowDangerouslySkipPermissions, extraArgs: require query restart
 */
export interface TurnSettings {
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  allowDangerouslySkipPermissions?: boolean;
  extraArgs?: Record<string, string | null>;
  /** Structured output schema — constrains model response to JSON matching schema. */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
}

/** Plugin descriptor for SDK-level plugin injection. */
export type LocalPlugin = { type: 'local'; path: string };

/** Options common to new/fork/hydrated targets (ephemeral child sessions). */
export interface EphemeralTargetOptions {
  skipPersistSession?: boolean;
  mcpServers?: Record<string, unknown>;
  plugins?: LocalPlugin[];
  env?: Record<string, string>;
  systemPrompt?: string;
  sessionKind?: 'user' | 'system'; // user-initiated vs internal/system session
}

/**
 * Target for a turn — where to send it.
 *
 * 'existing': send to an existing session
 * 'new': create a new session, then send
 * 'fork': fork from an existing session, then send
 * 'hydrated': create a new session pre-loaded with cross-vendor history, then send
 */
export type TurnTarget =
  | { kind: 'existing'; sessionId: string; model?: string }
  | { kind: 'new'; vendor: Vendor; cwd: string } & EphemeralTargetOptions
  | { kind: 'fork'; vendor: Vendor; fromSessionId: string; atMessageId?: string } & EphemeralTargetOptions
  | { kind: 'hydrated'; vendor: Vendor; cwd: string; history: TranscriptEntry[]; sourceVendor: Vendor; sourceSessionId?: string } & EphemeralTargetOptions;

/**
 * Intent to send a turn (user message + settings).
 *
 * The unified shape for all send operations. The session manager routes
 * by target.kind, broadcasts the user entry, then calls adapter.sendTurn().
 */
export interface TurnIntent {
  target: TurnTarget;
  content: MessageContent;
  clientMessageId: string;
  settings: TurnSettings;
}

/**
 * Receipt from sending a turn.
 *
 * Contains the session ID (may be pending:<uuid> for new/fork targets).
 */
export interface TurnReceipt {
  sessionId: string;
}

/** Vendor-agnostic session settings, readable from the adapter. */
export interface AdapterSettings {
  vendor: Vendor;
  model: string | undefined;
  permissionMode: string | undefined;
  allowDangerouslySkipPermissions: boolean;
  extraArgs: Record<string, string | null> | undefined;
}

/**
 * Discriminated union describing how to open a session.
 *
 * 'resume'   — reattach to an existing session by ID (current behavior)
 * 'fresh'    — start a brand-new session (no resume ID)
 * 'fork'     — fork from an existing session (future)
 * 'continue' — continue the most recent session in a CWD (future)
 * 'hydrated' — start a new session pre-loaded with cross-vendor history
 */
// Adapters MUST forward spec.env to the spawned process environment.
// session-manager injects CRISPY_SESSION_ID and CRISPY_SOCK into spec.env
// for all session modes (fresh, resume, fork).
export type SessionOpenSpec =
  | { mode: 'resume'; sessionId: string; cwd?: string; model?: string; permissionMode?: TurnSettings['permissionMode']; mcpServers?: Record<string, unknown>; plugins?: LocalPlugin[]; env?: Record<string, string>; systemPrompt?: string; sessionKind?: 'user' | 'system' }
  | { mode: 'fresh'; cwd: string; model?: string; permissionMode?: TurnSettings['permissionMode']; allowDangerouslySkipPermissions?: boolean; extraArgs?: Record<string, string | null>; skipPersistSession?: boolean; mcpServers?: Record<string, unknown>; plugins?: LocalPlugin[]; env?: Record<string, string>; systemPrompt?: string; sessionKind?: 'user' | 'system' }
  | { mode: 'fork'; fromSessionId: string; atMessageId?: string; model?: string; permissionMode?: TurnSettings['permissionMode']; allowDangerouslySkipPermissions?: boolean; skipPersistSession?: boolean; outputFormat?: TurnSettings['outputFormat']; mcpServers?: Record<string, unknown>; plugins?: LocalPlugin[]; env?: Record<string, string>; systemPrompt?: string; sessionKind?: 'user' | 'system' }
  | { mode: 'hydrated'; cwd: string; history: TranscriptEntry[]; sourceVendor: Vendor; sourceSessionId?: string; model?: string; permissionMode?: TurnSettings['permissionMode']; skipPersistSession?: boolean; mcpServers?: Record<string, unknown>; plugins?: LocalPlugin[]; env?: Record<string, string>; systemPrompt?: string; sessionKind?: 'user' | 'system' };

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

  /** Current session settings (model, permission mode, bypass, extra args). */
  readonly settings: AdapterSettings;

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
   * Send a user turn with settings applied atomically.
   *
   * This is the unified entry point for all user messages. Settings are
   * applied intelligently:
   * - model, permissionMode: live-changeable (applied mid-stream if active)
   * - allowDangerouslySkipPermissions, extraArgs: require query restart
   *
   * If query is active and restart-requiring settings changed, the current
   * query is torn down and a new one started with the new settings.
   *
   * User messages sent via sendTurn() are suppressed from echo (the session
   * manager broadcasts the user entry before calling sendTurn, so the adapter
   * should not re-emit it when the SDK echoes it back).
   *
   * Throws if the adapter is closed or awaiting approval.
   */
  sendTurn(content: MessageContent, settings: TurnSettings): void;

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
}
