/**
 * Per-message action buttons — appear on hover over user messages.
 *
 * Renders bottom-right of the user message bubble. Two buttons side by side:
 * - Rewind (↺): visual-only, logs to console on click
 * - Fork (⑂): forks the conversation at the preceding assistant message
 *
 * Hovering the fork button triggers a preview glow on the target assistant
 * message.
 *
 * @module MessageActions
 */

import { useFork } from '../context/ForkContext.js';
import { RewindIcon, ForkIcon } from './control-panel/icons.js';

interface MessageActionsProps {
  targetAssistantId: string;
}

export function MessageActions({ targetAssistantId }: MessageActionsProps): React.JSX.Element | null {
  const fork = useFork();
  if (!fork) return null;
  const { onFork, onForkPreviewHover, isStreaming } = fork;

  return (
    <div className="crispy-message-actions">
      <button
        className="crispy-message-action"
        title="Rewind to this message"
        disabled={isStreaming}
        onClick={() => console.log('[MessageActions] rewind (not wired)', targetAssistantId)}
        aria-label="Rewind conversation to this point"
      >
        <RewindIcon />
      </button>
      <button
        className="crispy-message-action"
        title="Fork from here"
        disabled={isStreaming}
        onClick={() => onFork(targetAssistantId)}
        onMouseEnter={() => onForkPreviewHover(targetAssistantId, true)}
        onMouseLeave={() => onForkPreviewHover(targetAssistantId, false)}
        aria-label="Fork conversation from this point"
      >
        <ForkIcon />
      </button>
    </div>
  );
}
