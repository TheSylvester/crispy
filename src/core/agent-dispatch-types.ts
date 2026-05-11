/**
 * Agent Dispatch Types — core-layer interface for in-process RPC dispatch.
 *
 * Defines the AgentDispatch interface that core modules depend on. The
 * concrete implementation lives in host/agent-dispatch.ts (createAgentDispatch).
 * This file exists so core modules can reference the dispatch shape without
 * importing from the host layer.
 *
 * @module core/agent-dispatch-types
 */

import type { SessionInfo, TurnIntent, TurnReceipt } from './agent-adapter.js';
import type { TranscriptEntry, MessageContent } from './transcript.js';
import type { ChildSessionOptions, ChildSessionResult, ListOpenChannelsOptions, OpenSessionInfo, ResumeChildOptions } from './session-manager.js';
import type { IdleReason } from './channel-idle.js';
import type { SessionTurn } from './rosie/tracker/turn-extractor.js';
import type { WorkspaceListResponse } from './workspace-roots.js';

export interface AgentDispatch {
  // Discovery
  listSessions(): Promise<SessionInfo[]>;
  listOpenSessions(params?: ListOpenChannelsOptions): Promise<OpenSessionInfo[]>;
  findSession(sessionId: string): Promise<SessionInfo | null>;
  loadSession(sessionId: string, options?: { until?: string }): Promise<TranscriptEntry[]>;

  // Session lifecycle
  subscribe(sessionId: string): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;
  sendTurn(intent: TurnIntent): Promise<TurnReceipt>;
  resolveApproval(sessionId: string, toolUseId: string, optionId: string, extra?: {
    message?: string;
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: unknown[];
  }): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;

  // Workspace & resolution
  listWorkspaces(): Promise<WorkspaceListResponse>;
  resolveSessionPrefix(prefix: string): Promise<string>;

  /** Dispatch an ephemeral child session — fork or new — collect result, auto-close. */
  dispatchChild(options: ChildSessionOptions): Promise<ChildSessionResult | null>;

  /** Resume an existing child session with a follow-up turn. */
  resumeChild(options: ResumeChildOptions): Promise<ChildSessionResult | null>;

  /** Block until a target session settles (turnComplete, debounced
   *  settled, or timeout). The target must be live in the host
   *  (`sessions: Map`) and not pending/tearing. */
  waitForIdle(params: { sessionId: string; timeoutMs?: number }): Promise<{ reason: IdleReason }>;

  /** Inject a turn into an existing live session — fire-and-forget,
   *  permissive on channel state. The caller does not need to be
   *  subscribed to the target. */
  postMessage(params: { sessionId: string; content: MessageContent; clientMessageId?: string }): Promise<{ sessionId: string }>;

  /** Read user↔assistant turn pairs (tool calls stripped) from a
   *  session's persisted messages. Works on any session with records
   *  in the messages table — open or closed. */
  readDialogue(params: { sessionId: string; from?: number; to?: number }): Promise<{ turns: SessionTurn[] }>;

  // Event delivery (event is typed as unknown at the core layer — host
  // consumers that need the concrete HostEvent type import it from
  // host/client-connection.ts)
  onEvent(handler: (sessionId: string, event: unknown) => void): () => void;

  // Cleanup
  dispose(): void;
}
