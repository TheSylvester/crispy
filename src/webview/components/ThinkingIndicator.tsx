/**
 * Thinking Indicator — animated spinner at the end of the transcript
 *
 * Shows while the session is streaming or awaiting approval, giving
 * visual feedback that the agent is active. The displayed label varies
 * by agency mode:
 *
 *   plan-mode           → "Planning…"
 *   bypass-permissions   → "Working…"
 *   edit-automatically   → "Working…"
 *   ask-before-edits     → "Thinking…"
 *
 * Because agency mode lives in ControlPanel's local reducer (no context),
 * the component renders all three labels and CSS `:has()` selectors on
 * `.crispy-main` show the correct one based on `.crispy-cp[data-agency]`.
 *
 * @module ThinkingIndicator
 */

import { useChannelState } from '../hooks/useSessionStatus.js';

interface ThinkingIndicatorProps {
  /** Per-tab session ID. Used to check channel state for this specific session. */
  sessionId?: string | null;
}

export function ThinkingIndicator({ sessionId = null }: ThinkingIndicatorProps): React.JSX.Element | null {
  const { channelState } = useChannelState(sessionId);

  const visible =
    channelState === 'streaming' || channelState === 'awaiting_approval';

  if (!visible) return null;

  return (
    <div className="crispy-thinking" aria-live="polite">
      <span className="crispy-thinking__spinner" />
      <span className="crispy-thinking__label crispy-thinking__label--thinking">Thinking…</span>
      <span className="crispy-thinking__label crispy-thinking__label--planning">Planning…</span>
      <span className="crispy-thinking__label crispy-thinking__label--working">Working…</span>
    </div>
  );
}
