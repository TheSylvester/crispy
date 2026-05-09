/**
 * SessionsPanel — list of currently-open Crispy sessions
 *
 * Lists live in-process channels via transport.listOpenSessions(). Each row
 * fires the injected `onActivate` callback on click — different shells wire
 * it differently (FlexLayout: navigate to a transcript tab; VS Code sidebar:
 * post a host message to reveal in an editor panel). Refreshes when the
 * session list or per-session status events fire, which is the cheapest
 * "live" signal — open/close/state transitions all bump sessionStatuses.
 *
 * @module sessions-panel/SessionsPanel
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import { useSession } from '../../context/SessionContext.js';
import { useGitInfo } from '../../hooks/useGitInfo.js';
import { formatRelativeTime } from '../../utils/format.js';
import type { OpenSessionInfo } from '../../transport.js';
import type { SessionChannelState } from '../../../core/session-channel.js';
import '../status-dot.css';
import './sessions-panel.css';

type SessionGroup =
  | { kind: 'cwd'; path: string; sessions: OpenSessionInfo[]; isAnchor: boolean }
  | { kind: 'other'; sessions: OpenSessionInfo[] };

const GROUP_HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px 2px',
  fontSize: 'var(--font-xs)',
  fontFamily: 'var(--font-mono)',
  opacity: 0.55,
  minWidth: 0,
};

const GROUP_HEADER_LABEL_STYLE: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

const GROUP_HEADER_CWD_STYLE: React.CSSProperties = {
  marginLeft: 'auto',
  opacity: 0.7,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '14ch',
  flexShrink: 0,
};

function basenameOf(path: string): string {
  if (!path) return '';
  const trimmed = path.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function maxActivity(sessions: OpenSessionInfo[]): number {
  let max = 0;
  for (const s of sessions) {
    if (!s.lastActivityAt) continue;
    const t = Date.parse(s.lastActivityAt);
    if (!Number.isNaN(t) && t > max) max = t;
  }
  return max;
}

interface SessionsPanelProps {
  mode?: 'sidebar' | 'tab';
  /** Click handler — caller decides how to surface the activated session. */
  onActivate?: (sessionId: string) => void;
}

type DotState = Exclude<SessionChannelState, 'unattached'>;

const STATE_DOT_CLASS: Record<DotState, string> = {
  idle: 'crispy-status-dot--idle',
  streaming: 'crispy-status-dot--streaming',
  background: 'crispy-status-dot--background',
  awaiting_approval: 'crispy-status-dot--approval',
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

export function SessionsPanel({ mode = 'sidebar', onActivate }: SessionsPanelProps): React.JSX.Element {
  const transport = useTransport();
  const { sessions, sessionStatuses, workspaceCwdPath } = useSession();
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
    onActivate?.(sessionId);
  }, [onActivate]);

  const groups = useMemo<SessionGroup[] | null>(() => {
    if (!openSessions) return null;
    const byPath = new Map<string | null, OpenSessionInfo[]>();
    for (const s of openSessions) {
      const key = s.projectPath && s.projectPath.length > 0 ? s.projectPath : null;
      const existing = byPath.get(key);
      if (existing) existing.push(s);
      else byPath.set(key, [s]);
    }

    const cwdGroups: Extract<SessionGroup, { kind: 'cwd' }>[] = [];
    let other: Extract<SessionGroup, { kind: 'other' }> | null = null;
    for (const [key, sessionsForGroup] of byPath) {
      if (key === null) {
        other = { kind: 'other', sessions: sessionsForGroup };
      } else {
        cwdGroups.push({
          kind: 'cwd',
          path: key,
          sessions: sessionsForGroup,
          isAnchor: key === workspaceCwdPath,
        });
      }
    }

    cwdGroups.sort((a, b) => {
      if (a.isAnchor !== b.isAnchor) return a.isAnchor ? -1 : 1;
      return maxActivity(b.sessions) - maxActivity(a.sessions);
    });

    return other ? [...cwdGroups, other] : cwdGroups;
  }, [openSessions, workspaceCwdPath]);

  const panelClass = `crispy-sessions-panel${mode === 'tab' ? ' crispy-sessions-panel--tab' : ''}`;

  return (
    <div className={panelClass}>
      <div className="crispy-sessions-panel__list">
        {groups === null ? (
          <div className="crispy-sessions-panel__empty">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="crispy-sessions-panel__empty">No open sessions</div>
        ) : (
          groups.map((group) => (
            <SessionGroupSection
              key={group.kind === 'other' ? '__other__' : group.path}
              group={group}
              onClick={handleClick}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface SessionGroupSectionProps {
  group: SessionGroup;
  onClick: (sessionId: string) => void;
}

function SessionGroupSection({ group, onClick }: SessionGroupSectionProps): React.JSX.Element {
  return (
    <>
      {group.kind === 'other' ? <OtherGroupHeader /> : <CwdGroupHeader group={group} />}
      {group.sessions.map((s) => (
        <SessionRow key={s.sessionId} s={s} onClick={onClick} />
      ))}
    </>
  );
}

function OtherGroupHeader(): React.JSX.Element {
  return (
    <div style={GROUP_HEADER_STYLE} title="Other">
      <span style={GROUP_HEADER_LABEL_STYLE}>Other</span>
    </div>
  );
}

interface CwdGroupHeaderProps {
  group: Extract<SessionGroup, { kind: 'cwd' }>;
}

function CwdGroupHeader({ group }: CwdGroupHeaderProps): React.JSX.Element {
  const gitInfo = useGitInfo(group.path);
  const branch = gitInfo?.branch ?? '';
  const basename = basenameOf(group.path);
  const label = branch || basename || group.path;
  const showCwdSuffix = !group.isAnchor && !!branch && basename !== branch;
  const titleText = branch ? `${branch} — ${group.path}` : group.path;

  return (
    <div style={GROUP_HEADER_STYLE} title={titleText}>
      <span style={GROUP_HEADER_LABEL_STYLE}>{label}</span>
      {gitInfo?.dirty && (
        <span className="crispy-sessions-panel__git-dirty" aria-label="uncommitted changes">●</span>
      )}
      {showCwdSuffix && <span style={GROUP_HEADER_CWD_STYLE}>{basename}</span>}
    </div>
  );
}

interface SessionRowProps {
  s: OpenSessionInfo;
  onClick: (sessionId: string) => void;
}

function SessionRow({ s, onClick }: SessionRowProps): React.JSX.Element {
  const label = labelFor(s);
  const message = messageFor(s);
  const dotModifier = STATE_DOT_CLASS[s.state] ?? '';
  const time = s.lastActivityAt ? formatRelativeTime(s.lastActivityAt) : '';
  const rowClass = `crispy-sessions-panel__row${s.attached ? '' : ' crispy-sessions-panel__row--detached'}`;
  const rowTitle = s.attached
    ? `${label}\n${s.sessionId}`
    : `${label}\n${s.sessionId}\n(no window open — will close in ~30s if idle)`;
  return (
    <button className={rowClass} onClick={() => onClick(s.sessionId)} title={rowTitle}>
      <span className={`crispy-status-dot ${dotModifier}`} />
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
        {message && (
          <span className="crispy-sessions-panel__line-2">
            <span className="crispy-sessions-panel__message">{message}</span>
          </span>
        )}
      </span>
    </button>
  );
}
