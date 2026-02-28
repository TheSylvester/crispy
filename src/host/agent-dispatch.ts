/**
 * Agent dispatch — loopback client of client-connection.
 *
 * Same routing, subscription tracking, and session ID re-keying as the
 * webview, but in-process with no wire protocol overhead. Creates its own
 * ClientConnection and exposes a typed API over call().
 *
 * Does NOT: orchestrate multi-step flows, manage timeouts, extract results.
 * That's the dispatch-handler's job.
 */

import type { SessionInfo, TurnIntent, TurnReceipt } from '../core/agent-adapter.js';
import type { TranscriptEntry } from '../core/transcript.js';
import type { HostEvent, HostMessage } from './client-connection.js';
import { createClientConnection } from './client-connection.js';

export interface AgentDispatch {
  // Discovery
  listSessions(): Promise<SessionInfo[]>;
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

  // Event delivery
  onEvent(handler: (sessionId: string, event: HostEvent) => void): () => void;

  // Cleanup
  dispose(): void;
}

export function createAgentDispatch(): AgentDispatch {
  const clientId = `dispatch-${crypto.randomUUID()}`;
  const eventHandlers = new Set<(sessionId: string, event: HostEvent) => void>();

  const connection = createClientConnection(clientId, (msg: HostMessage) => {
    if (msg.kind === 'event') {
      for (const handler of eventHandlers) {
        handler(msg.sessionId, msg.event);
      }
    }
    // 'response' and 'error' never arrive here — call() returns directly
  });

  return {
    listSessions: () => connection.call('listSessions', {}) as Promise<SessionInfo[]>,
    findSession: (id) => connection.call('findSession', { sessionId: id }) as Promise<SessionInfo | null>,
    loadSession: (id, opts) => connection.call('loadSession', { sessionId: id, ...opts }) as Promise<TranscriptEntry[]>,
    subscribe: (id) => connection.call('subscribe', { sessionId: id }).then(() => {}),
    unsubscribe: (id) => connection.call('unsubscribe', { sessionId: id }).then(() => {}),
    sendTurn: (intent) => connection.call('sendTurn', { intent }) as Promise<TurnReceipt>,
    resolveApproval: (sessionId, toolUseId, optionId, extra) =>
      connection.call('resolveApproval', { sessionId, toolUseId, optionId, extra }).then(() => {}),
    interrupt: (id) => connection.call('interrupt', { sessionId: id }).then(() => {}),
    close: (id) => connection.call('close', { sessionId: id }).then(() => {}),

    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },

    dispose() {
      eventHandlers.clear();
      connection.dispose();
    },
  };
}
