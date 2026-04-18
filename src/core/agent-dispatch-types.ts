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
import type { TranscriptEntry } from './transcript.js';
import type { ChildSessionOptions, ChildSessionResult, ListOpenChannelsOptions, OpenSessionInfo, ResumeChildOptions } from './session-manager.js';
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

  // Event delivery (event is typed as unknown at the core layer — host
  // consumers that need the concrete HostEvent type import it from
  // host/client-connection.ts)
  onEvent(handler: (sessionId: string, event: unknown) => void): () => void;

  // Cleanup
  dispose(): void;
}
