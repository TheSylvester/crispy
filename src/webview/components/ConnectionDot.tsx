/**
 * ConnectionDot — per-tab streaming/idle/approval indicator.
 *
 * 8px colored dot with state-driven color + glow animation.
 * Click-to-copy session ID (Leto pattern: flash "copied" feedback).
 * Rendered inside each TranscriptHeader so every tab shows its own state.
 *
 * @module ConnectionDot
 */

import { useState } from 'react';

export function ConnectionDot({
  channelState,
  sessionId,
}: {
  channelState: string | null;
  sessionId: string | null;
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);

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
      console.error('[ConnectionDot] Failed to copy session ID');
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
