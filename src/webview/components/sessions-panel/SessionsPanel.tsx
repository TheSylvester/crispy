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

function labelFor(s: OpenSessionInfo): string {
  return s.title || s.lastUserPrompt || `${s.sessionId.slice(0, 8)}…`;
}

function basenameOf(path: string | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function subtitleFor(s: OpenSessionInfo): string | null {
  const parts: string[] = [];
  if (s.vendor && s.vendor !== 'unknown') parts.push(s.vendor);
  const cwd = basenameOf(s.projectPath);
  if (cwd) parts.push(cwd);
  if (parts.length === 0) return null;
  return parts.join(' · ');
}

export function SessionsPanel({ mode = 'sidebar' }: SessionsPanelProps): React.JSX.Element {
  const transport = useTransport();
  const { sessions, sessionStatuses } = useSession();
  const tabController = useTabController();
  const [openSessions, setOpenSessions] = useState<OpenSessionInfo[] | null>(null);

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
            const subtitle = subtitleFor(s);
            const dotClass = STATE_DOT_CLASS[s.state] ?? 'crispy-sessions-panel__dot--unknown';
            return (
              <button
                key={s.sessionId}
                className="crispy-sessions-panel__row"
                onClick={() => handleClick(s.sessionId)}
                title={`${label}\n${s.sessionId}`}
              >
                <span className={`crispy-sessions-panel__dot ${dotClass}`} />
                <span className="crispy-sessions-panel__row-text">
                  <span className="crispy-sessions-panel__label">{label}</span>
                  {subtitle && <span className="crispy-sessions-panel__subtitle">{subtitle}</span>}
                </span>
                {s.pendingApprovalCount > 0 && (
                  <span className="crispy-sessions-panel__badge" title={`${s.pendingApprovalCount} pending approval(s)`}>
                    {s.pendingApprovalCount}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
