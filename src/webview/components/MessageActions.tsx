/**
 * Per-message action buttons -- appear on hover over user messages.
 *
 * Renders bottom-right of the user message bubble:
 * - Rewind: fork-in-same-panel with original user text pre-filled
 * - Fork: forks to a new panel at the preceding assistant message
 *
 * Reads fork targets from ForkContext to resolve the preceding assistant
 * message ID from the entry's UUID. When targetAssistantId is null (first
 * user message -- no preceding assistant), only the rewind button renders.
 * Rewind with null target starts a fresh session with the original prompt
 * pre-filled.
 *
 * @module MessageActions
 */

import { useFork } from '../context/ForkContext.js';
import { RewindIcon, ForkIcon } from './control-panel/icons.js';

interface MessageActionsProps {
  /** UUID of the user message entry, used to look up the fork target. */
  entryUuid: string;
}

export function MessageActions({ entryUuid }: MessageActionsProps): React.JSX.Element | null {
  const fork = useFork();
  if (!fork) return null;
  const { onFork, onRewind, onForkPreviewHover, isStreaming, forkTargets } = fork;

  const targetAssistantId = forkTargets.get(entryUuid) ?? null;

  return (
    <div className="crispy-message-actions">
      <button
        className="crispy-message-action"
        title="Rewind to this message"
        disabled={isStreaming}
        onClick={() => onRewind(targetAssistantId ?? '')}
        onMouseEnter={targetAssistantId ? () => onForkPreviewHover(targetAssistantId, true) : undefined}
        onMouseLeave={targetAssistantId ? () => onForkPreviewHover(targetAssistantId, false) : undefined}
        aria-label="Rewind conversation to this point"
      >
        <RewindIcon />
      </button>
      {targetAssistantId && (
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
      )}
    </div>
  );
}
