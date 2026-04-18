/**
 * Agent dispatch — loopback client of client-connection.
 *
 * Same routing, subscription tracking, and session ID re-keying as the
 * webview, but in-process with no wire protocol overhead. Creates its own
 * ClientConnection and exposes a typed API over call().
 *
 * Does NOT: orchestrate multi-step flows, manage timeouts, extract results.
 * That's the dispatch-handler's job.
 *
 * The AgentDispatch interface is defined in core/agent-dispatch-types.ts so
 * that core modules can reference it without a core→host import. This file
 * re-exports the interface and provides the concrete factory.
 */

import { randomUUID } from 'node:crypto';
import type { SessionInfo, TurnReceipt } from '../core/agent-adapter.js';
import type { TranscriptEntry } from '../core/transcript.js';
import type { ChildSessionResult, OpenSessionInfo } from '../core/session-manager.js';
import type { WorkspaceListResponse } from '../core/workspace-roots.js';
import type { HostEvent, HostMessage } from './client-connection.js';
import { createClientConnection } from './client-connection.js';

// Re-export the interface from core so existing host-layer importers
// continue to work without changing their import paths.
export type { AgentDispatch } from '../core/agent-dispatch-types.js';
import type { AgentDispatch } from '../core/agent-dispatch-types.js';

export function createAgentDispatch(): AgentDispatch {
  const clientId = `dispatch-${randomUUID()}`;
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
    listOpenSessions: (params) =>
      connection.call('listOpenSessions', (params ?? {}) as Record<string, unknown>) as Promise<OpenSessionInfo[]>,
    findSession: (id) => connection.call('findSession', { sessionId: id }) as Promise<SessionInfo | null>,
    loadSession: (id, opts) => connection.call('loadSession', { sessionId: id, ...opts }) as Promise<TranscriptEntry[]>,
    subscribe: (id) => connection.call('subscribe', { sessionId: id }).then(() => {}),
    unsubscribe: (id) => connection.call('unsubscribe', { sessionId: id }).then(() => {}),
    sendTurn: (intent) => connection.call('sendTurn', { intent }) as Promise<TurnReceipt>,
    resolveApproval: (sessionId, toolUseId, optionId, extra) =>
      connection.call('resolveApproval', { sessionId, toolUseId, optionId, extra }).then(() => {}),
    interrupt: (id) => connection.call('interrupt', { sessionId: id }).then(() => {}),
    close: (id) => connection.call('close', { sessionId: id }).then(() => {}),
    listWorkspaces: () => connection.call('listWorkspaces', {}) as Promise<WorkspaceListResponse>,
    resolveSessionPrefix: (prefix) => connection.call('resolveSessionPrefix', { sessionId: prefix }).then((r) => (r as { sessionId: string }).sessionId),
    dispatchChild: (options) => connection.call('dispatchChild', options as unknown as Record<string, unknown>) as Promise<ChildSessionResult | null>,
    resumeChild: (options) => connection.call('resumeChild', options as unknown as Record<string, unknown>) as Promise<ChildSessionResult | null>,

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
