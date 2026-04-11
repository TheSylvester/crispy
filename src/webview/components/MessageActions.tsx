/**
 * Per-message action buttons — appear on hover over user messages.
 *
 * Renders bottom-right of the user message bubble:
 * - Rewind (↺): fork-in-same-panel with original user text pre-filled
 * - Fork (⑂): forks to a new panel at the preceding assistant message
 *
 * When targetAssistantId is null (first user message — no preceding assistant),
 * only the rewind button renders. Rewind with null target starts a fresh
 * session with the original prompt pre-filled.
 *
 * @module MessageActions
 */

import { useFork } from '../context/ForkContext.js';
import { RewindIcon, ForkIcon } from './control-panel/icons.js';
import { CopyButton } from './CopyButton.js';

interface MessageActionsProps {
  /** Preceding assistant message UUID, or null for first user message (rewind-only). */
  targetAssistantId: string | null;
  /** When provided, renders a copy button as the first action. */
  copygetText?: () => string | null;
}

export function MessageActions({ targetAssistantId, copygetText }: MessageActionsProps): React.JSX.Element | null {
  const fork = useFork();
  if (!fork) return null;
  const { onFork, onRewind, onForkPreviewHover, isStreaming } = fork;

  return (
    <div className="crispy-message-actions">
      {copygetText && (
        <CopyButton
          getText={copygetText}
          title="Copy message"
          compact
          className="crispy-message-action"
        />
      )}
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
