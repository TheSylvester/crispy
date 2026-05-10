/**
 * InlineRename — shared inline-edit input for session title rename
 *
 * Used by:
 *   - SessionItem (dropdown rows)
 *   - SessionRow (Open Sessions sidebar)
 *   - TabHeader (Conversations dropdown trigger)
 *
 * Behavior (locked from rename-sessions plan §J):
 *   Enter   → submit trimmed; if empty or unchanged, just exit (no RPC)
 *   Escape  → exit without submit
 *   Blur    → exit without submit (cancel-on-outside, v1)
 *   Submit success → onDone()
 *   Submit error → onError(msg) + onDone()
 *
 * Stops propagation on Arrow/Enter/Escape/mousedown so:
 *   - Dropdown keyboard nav doesn't intercept Enter/Escape
 *   - Wrapping <button> (SessionRow's row root) doesn't fire on click
 *
 * Capped at 100 chars in the UI; backend has no cap (vendors handle their own).
 *
 * @module components/session-rename/InlineRename
 */

import { useEffect, useRef, useState } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import './inline-rename.css';

const MAX_LEN = 100;

export interface InlineRenameProps {
  sessionId: string;
  currentTitle: string;
  onDone: () => void;
  onError: (msg: string) => void;
  className?: string;
}

export function InlineRename({
  sessionId,
  currentTitle,
  onDone,
  onError,
  className,
}: InlineRenameProps): React.JSX.Element {
  const transport = useTransport();
  const [value, setValue] = useState(currentTitle);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  function commit(next: string): void {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const trimmed = next.trim();
    if (!trimmed || trimmed === currentTitle.trim()) {
      onDone();
      return;
    }
    setSubmitting(true);
    transport
      .setSessionTitle(sessionId, trimmed)
      .then(() => {
        onDone();
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        onError(`Rename failed: ${msg}`);
        onDone();
      });
  }

  function cancel(): void {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onDone();
  }

  return (
    <input
      ref={inputRef}
      type="text"
      className={['crispy-inline-rename', className].filter(Boolean).join(' ')}
      value={value}
      maxLength={MAX_LEN}
      disabled={submitting}
      aria-label="Rename session"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          // Don't let dropdown keyboard nav intercept while editing.
          e.stopPropagation();
        }
      }}
      onBlur={() => {
        // v1 decision: blur cancels (matches Codex-style click-outside cancel).
        cancel();
      }}
      onMouseDown={(e) => {
        // Don't let parents (button rows, dropdown triggers) intercept clicks.
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
      }}
    />
  );
}
