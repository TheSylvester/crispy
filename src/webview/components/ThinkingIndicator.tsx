/**
 * Thinking Indicator — animated spinner at the end of the transcript
 *
 * Shows while the session is streaming or awaiting approval, giving
 * visual feedback that the agent is active. The displayed label varies
 * by agency mode:
 *
 *   plan-mode           → "planning"
 *   bypass-permissions   → "working"
 *   edit-automatically   → "working"
 *   ask-before-edits     → "thinking"
 *
 * Because agency mode lives in ControlPanel's local reducer (no context),
 * the component renders all three labels and CSS `:has()` selectors on
 * `.crispy-main` show the correct one based on `.crispy-cp[data-agency]`.
 *
 * @module ThinkingIndicator
 */

import { useSession } from '../context/SessionContext.js';
import { useSessionStatus } from '../hooks/useSessionStatus.js';

export function ThinkingIndicator(): React.JSX.Element | null {
  const { selectedSessionId } = useSession();
  const { channelState } = useSessionStatus(selectedSessionId);

  const visible =
    channelState === 'streaming' || channelState === 'awaiting_approval';

  if (!visible) return null;

  return (
    <div className="crispy-thinking" aria-live="polite">
      <span className="crispy-thinking__spinner" />
      <span className="crispy-thinking__label crispy-thinking__label--thinking">thinking</span>
      <span className="crispy-thinking__label crispy-thinking__label--planning">planning</span>
      <span className="crispy-thinking__label crispy-thinking__label--working">working</span>
    </div>
  );
}
