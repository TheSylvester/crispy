/**
 * Per-message fork button — appears on hover over user messages.
 *
 * Renders bottom-right of the user message bubble. Clicking forks the
 * conversation at the preceding assistant message. Hovering triggers
 * a preview glow on the target assistant message.
 *
 * @module MessageForkButton
 */

import { useFork } from '../context/ForkContext.js';
import { ForkIcon } from './control-panel/icons.js';

interface MessageForkButtonProps {
  targetAssistantId: string;
}

export function MessageForkButton({ targetAssistantId }: MessageForkButtonProps): React.JSX.Element | null {
  const fork = useFork();
  if (!fork) return null;
  const { onFork, onForkPreviewHover, isStreaming } = fork;

  return (
    <button
      className="crispy-message-fork"
      title="Fork from here"
      disabled={isStreaming}
      onClick={() => onFork(targetAssistantId)}
      onMouseEnter={() => onForkPreviewHover(targetAssistantId, true)}
      onMouseLeave={() => onForkPreviewHover(targetAssistantId, false)}
      aria-label="Fork conversation from this point"
    >
      <ForkIcon />
    </button>
  );
}
