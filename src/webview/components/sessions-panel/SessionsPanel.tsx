/**
 * SessionsPanel — list of currently-open Crispy sessions
 *
 * Lists live in-process channels via transport.listOpenSessions(). Each row
 * activates that session's transcript tab on click (creating one if none
 * exists). Refreshes when the session list or per-session status events fire,
 * which is the cheapest "live" signal — open/close/state transitions all
 * bump sessionStatuses.
 *
 * @module sessions-panel/SessionsPanel
 */

import { useCallback, useEffect, useState } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import { useSession } from '../../context/SessionContext.js';
import { useTabController } from '../../context/TabControllerContext.js';
import { formatRelativeTime } from '../../utils/format.js';
import type { OpenSessionInfo } from '../../transport.js';
import type { SessionChannelState } from '../../../core/session-channel.js';
import './sessions-panel.css';

interface SessionsPanelProps {
  mode?: 'sidebar' | 'tab';
}

type DotState = Exclude<SessionChannelState, 'unattached'>;

const STATE_DOT_CLASS: Record<DotState, string> = {
  idle: 'crispy-sessions-panel__dot--idle',
  streaming: 'crispy-sessions-panel__dot--streaming',
  background: 'crispy-sessions-panel__dot--background',
  awaiting_approval: 'crispy-sessions-panel__dot--approval',
};

// Keep relative timestamps fresh without depending on session-status churn.
// formatRelativeTime rounds to whole minutes after 60s, so a 15s tick is
// granular enough and the cost is one setState per interval.
const TIME_TICK_MS = 15_000;

function labelFor(s: OpenSessionInfo): string {
  return s.title || s.lastUserPrompt || `${s.sessionId.slice(0, 8)}…`;
}

/**
 * Second-line text. Prefers `lastMessage`; when empty (agent is running tools,
 * not speaking — the dropdown's "no preview" case), falls back to a state
 * hint so row heights stay uniform.
 */
function messageFor(s: OpenSessionInfo): string {
  if (s.lastMessage) return s.lastMessage;
  switch (s.state) {
    case 'streaming': return 'Running tools…';
    case 'background': return 'Background task running';
    case 'awaiting_approval': return 'Awaiting approval';
    case 'idle': return '';
  }
}

export function SessionsPanel({ mode = 'sidebar' }: SessionsPanelProps): React.JSX.Element {
  const transport = useTransport();
  const { sessions, sessionStatuses } = useSession();
  const tabController = useTabController();
  const [openSessions, setOpenSessions] = useState<OpenSessionInfo[] | null>(null);
  const [, setNowTick] = useState(0);

  // Refresh whenever the session list or per-session status events fire.
  // Both signals bump on open/close/state transitions, so this keeps the
  // panel live without needing a dedicated subscription channel.
  useEffect(() => {
    const cancelled = { current: false };
    transport.listOpenSessions().then(
      (result) => {
        if (cancelled.current) return;
        // Skip the re-render when the wire result is byte-identical (matches
        // the GitPanel convention for high-frequency refresh sources).
        setOpenSessions(prev =>
          prev && JSON.stringify(prev) === JSON.stringify(result) ? prev : result,
        );
      },
      () => {
        if (cancelled.current) return;
        setOpenSessions([]);
      },
    );
    return () => { cancelled.current = true; };
  }, [transport, sessions, sessionStatuses]);

  // Tick re-render so relative times advance even when no status events fire.
  useEffect(() => {
    const id = setInterval(() => setNowTick(t => t + 1), TIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const handleClick = useCallback((sessionId: string) => {
    tabController.navigateToSession(sessionId);
  }, [tabController]);

  const panelClass = `crispy-sessions-panel${mode === 'tab' ? ' crispy-sessions-panel--tab' : ''}`;
  const count = openSessions?.length ?? 0;

  return (
    <div className={panelClass}>
      <div className="crispy-sessions-panel__header">
        <span className="crispy-sessions-panel__title">OPEN SESSIONS</span>
        <span className="crispy-sessions-panel__count">{count}</span>
      </div>
      <div className="crispy-sessions-panel__list">
        {openSessions === null ? (
          <div className="crispy-sessions-panel__empty">Loading…</div>
        ) : openSessions.length === 0 ? (
          <div className="crispy-sessions-panel__empty">No open sessions</div>
        ) : (
          openSessions.map((s) => {
            const label = labelFor(s);
            const message = messageFor(s);
            const dotClass = STATE_DOT_CLASS[s.state] ?? 'crispy-sessions-panel__dot--unknown';
            const time = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : '';
            return (
              <button
                key={s.sessionId}
                className="crispy-sessions-panel__row"
                onClick={() => handleClick(s.sessionId)}
                title={`${label}\n${s.sessionId}`}
              >
                <span className={`crispy-sessions-panel__dot ${dotClass}`} />
                <span className="crispy-sessions-panel__row-text">
                  <span className="crispy-sessions-panel__line-1">
                    <span className="crispy-sessions-panel__label">{label}</span>
                    {s.pendingApprovalCount > 0 && (
                      <span className="crispy-sessions-panel__badge" title={`${s.pendingApprovalCount} pending approval(s)`}>
                        {s.pendingApprovalCount}
                      </span>
                    )}
                    {time && <span className="crispy-sessions-panel__time">{time}</span>}
                  </span>
                  {message && <span className="crispy-sessions-panel__message">{message}</span>}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
