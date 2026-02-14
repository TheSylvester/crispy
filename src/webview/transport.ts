/**
 * SessionService Interface — Client-Side RPC
 *
 * Typed RPC methods for communicating with the host. Both VS Code
 * postMessage and WebSocket transports implement this interface.
 * The transport pipe (postMessage vs WebSocket) is invisible to consumers.
 *
 * @module transport
 */

import type { SessionInfo, SendOptions } from '../core/agent-adapter.js';
import type { TranscriptEntry, MessageContent } from '../core/transcript.js';
import type { HostEvent } from '../host/client-connection.js';
import type { ApprovalExtra } from './components/approval/types.js';

/** Client-side session info — modifiedAt is a string after JSON serialization. */
export interface WireSessionInfo extends Omit<SessionInfo, 'modifiedAt'> {
  modifiedAt: string;
}

export interface SessionService {
  listSessions(): Promise<WireSessionInfo[]>;
  findSession(sessionId: string): Promise<WireSessionInfo | null>;
  loadSession(sessionId: string): Promise<TranscriptEntry[]>;
  createSession(vendor: string, cwd: string, options?: {
    model?: string;
    permissionMode?: string;
    extraArgs?: Record<string, string | null>;
  }): Promise<{ pendingId: string }>;
  subscribe(sessionId: string): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;
  send(sessionId: string, content: MessageContent, options?: SendOptions): Promise<void>;
  resolveApproval(sessionId: string, toolUseId: string, optionId: string, extra?: ApprovalExtra): Promise<void>;
  setModel(sessionId: string, model?: string): Promise<void>;
  setPermissions(sessionId: string, mode: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  reconfigure(sessionId: string, updates: {
    allowDangerouslySkipPermissions?: boolean;
    extraArgs?: Record<string, string | null>;
  }): Promise<void>;
  close(sessionId: string): Promise<void>;
  subscribeSessionList(): Promise<void>;
  unsubscribeSessionList(): Promise<void>;
  onEvent(handler: (sessionId: string, event: HostEvent) => void): () => void;
  getGitFiles(cwd: string): Promise<string[]>;
  fileExists(path: string): Promise<boolean>;
  readImage(path: string): Promise<{ data: string; mimeType: string; fileName: string }>;
  openFile(path: string, line?: number, col?: number): Promise<{ opened: boolean }>;
  pickFile(candidates: string[]): Promise<{ picked: string | null }>;
  dispose(): void;
}

/** @deprecated Use SessionService instead. */
export type Transport = SessionService;
