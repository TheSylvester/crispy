/**
 * Transport Interface — Client-Side RPC
 *
 * Typed RPC methods for communicating with the host. Both VS Code
 * postMessage and WebSocket transports implement this interface.
 *
 * @module transport
 */

import type { SessionInfo } from '../core/agent-adapter.js';
import type { TranscriptEntry, MessageContent } from '../core/transcript.js';
import type { SubscriberEvent } from '../core/session-channel.js';

/** Client-side session info — modifiedAt is a string after JSON serialization. */
export interface WireSessionInfo extends Omit<SessionInfo, 'modifiedAt'> {
  modifiedAt: string;
}

export interface Transport {
  listSessions(): Promise<WireSessionInfo[]>;
  findSession(sessionId: string): Promise<WireSessionInfo | null>;
  loadSession(sessionId: string): Promise<TranscriptEntry[]>;
  subscribe(sessionId: string): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;
  send(sessionId: string, content: MessageContent): Promise<void>;
  resolveApproval(sessionId: string, toolUseId: string, optionId: string): Promise<void>;
  setModel(sessionId: string, model?: string): Promise<void>;
  setPermissions(sessionId: string, mode: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  onEvent(handler: (sessionId: string, event: SubscriberEvent) => void): void;
  dispose(): void;
}
