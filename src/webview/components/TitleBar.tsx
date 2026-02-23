/**
 * TitleBar — Fixed header with CWD selector and connection status
 *
 * Slim single-row bar. Session dropdown and +New button now live in the
 * transcript tab header (see FlexAppLayout). Files/Tools toggles removed
 * in favour of FlexLayout border tabs.
 *
 * @module TitleBar
 */

import { useCallback, useMemo, useState } from 'react';
import { useSession } from '../context/SessionContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';
import { useCwd } from '../hooks/useSessionCwd.js';
import { useAvailableCwds } from '../hooks/useAvailableCwds.js';

/**
 * Connection indicator — 8px dot with state-driven color + glow.
 * Click-to-copy session ID (Leto pattern: flash "copied" feedback).
 */
function ConnectionDot({
  channelState,
  sessionId,
}: {
  channelState: string | null;
  sessionId: string | null;
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);

  // Only show dot when a session is selected and has a known state
  const dotModifier =
    channelState === 'streaming'
      ? 'crispy-titlebar__dot--streaming'
      : channelState === 'idle'
        ? 'crispy-titlebar__dot--idle'
        : channelState === 'awaiting_approval'
          ? 'crispy-titlebar__dot--approval'
          : null;

  if (!dotModifier) return null;

  const dotClass = `crispy-titlebar__dot ${dotModifier}${copied ? ' crispy-titlebar__dot--copied' : ''}`;

  const handleCopy = async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      console.error('[TitleBar] Failed to copy session ID');
    }
  };

  const title = copied
    ? 'Copied!'
    : sessionId
      ? `${channelState} · click to copy session ID`
      : `Status: ${channelState}`;

  return (
    <span
      className={dotClass}
      title={title}
      onClick={handleCopy}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCopy(); }}
    />
  );
}

export function TitleBar(): React.JSX.Element {
  const { selectedSessionId, selectedCwd, setSelectedCwd } = useSession();
  const { channelState } = useSessionStatus(selectedSessionId);
  const { fullPath } = useCwd();
  const allCwds = useAvailableCwds();

  /** Cap visible CWDs to keep the native dropdown manageable.
   *  Always includes the currently selected CWD even if it falls outside the cap. */
  const MAX_CWDS = 15;
  const availableCwds = useMemo(() => {
    if (allCwds.length <= MAX_CWDS) return allCwds;
    const top = allCwds.slice(0, MAX_CWDS);
    if (selectedCwd && !top.some((c) => c.slug === selectedCwd)) {
      const selected = allCwds.find((c) => c.slug === selectedCwd);
      if (selected) top.push(selected);
    }
    return top;
  }, [allCwds, selectedCwd]);

  const handleCwdChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedCwd(e.target.value || null);
  }, [setSelectedCwd]);

  return (
    <header className="crispy-titlebar">
      {/* CWD dropdown + connection indicator — now the sole titlebar content */}
      <div className="crispy-titlebar__center">
        {availableCwds.length > 0 && (
          <select
            className="crispy-titlebar__cwd-select"
            value={selectedCwd ?? ''}
            onChange={handleCwdChange}
            title={fullPath ?? 'All projects'}
          >
            <option value="">All Projects</option>
            {availableCwds.map((cwd) => (
              <option key={cwd.slug} value={cwd.slug} title={cwd.fullPath}>
                {cwd.display}
              </option>
            ))}
          </select>
        )}
        <ConnectionDot channelState={channelState} sessionId={selectedSessionId} />
      </div>
    </header>
  );
}
