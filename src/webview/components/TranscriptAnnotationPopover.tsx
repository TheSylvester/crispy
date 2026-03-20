/**
 * TranscriptAnnotationPopover — floating annotation UI for transcript selections
 *
 * Portal-rendered popover positioned above the text selection. Two states:
 * "Annotate" button and textarea + submit/cancel actions. Structurally mirrors
 * the popover in FileViewerModal but operates on transcript assistant entries.
 *
 * Viewport clamping: after initial render, measures the popover and adjusts
 * position so it stays within 8px of all viewport edges (same pattern as
 * FileContextMenu).
 *
 * @module components/TranscriptAnnotationPopover
 */

import { useRef, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TranscriptAnnotationState } from '../hooks/useTranscriptAnnotation.js';

/** Clamp popover position so it doesn't overflow the viewport */
function clampToViewport(
  rect: DOMRect,
  popoverEl: HTMLDivElement,
): { top: number; left: number } {
  const pad = 8;
  const pr = popoverEl.getBoundingClientRect();
  const vw = window.innerWidth;

  // Desired: centered above selection
  let left = rect.left + rect.width / 2 - pr.width / 2;
  let top = rect.top - pad - pr.height;

  // Clamp horizontal
  if (left + pr.width > vw - pad) left = vw - pr.width - pad;
  if (left < pad) left = pad;

  // If above would go off-screen top, flip below
  if (top < pad) top = rect.bottom + pad;

  return { top, left };
}

export function TranscriptAnnotationPopover({
  selection,
  annotationMode,
  annotationText,
  setAnnotationText,
  enterAnnotationMode,
  submitAnnotation,
  cancelAnnotation,
}: TranscriptAnnotationState): React.JSX.Element | null {
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measure and clamp after render (selection change or mode change)
  useEffect(() => {
    if (!selection || !popoverRef.current) { setPos(null); return; }
    setPos(clampToViewport(selection.rect, popoverRef.current));
  }, [selection, annotationMode]);

  // Auto-focus textarea on annotation mode
  useEffect(() => {
    if (annotationMode && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [annotationMode]);

  if (!selection) return null;

  // First render: position off-screen to measure, then clamp
  const style = pos
    ? { top: pos.top, left: pos.left, transform: 'none' }
    : { top: -9999, left: -9999, transform: 'none' };

  return createPortal(
    <div
      ref={popoverRef}
      className="crispy-annotation-popover"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {!annotationMode ? (
        <button
          className="crispy-annotation-popover__btn"
          onClick={enterAnnotationMode}
          title="Quote selected text into chat"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 1H2a1 1 0 00-1 1v8a1 1 0 001 1h3l3 3 3-3h3a1 1 0 001-1V2a1 1 0 00-1-1zM4 4h8v1H4V4zm0 3h6v1H4V7z" />
          </svg>
          <span>Quote</span>
        </button>
      ) : (
        <div className="crispy-annotation-popover__input">
          <textarea
            ref={textareaRef}
            className="crispy-annotation-popover__textarea"
            value={annotationText}
            onChange={(e) => setAnnotationText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitAnnotation();
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                cancelAnnotation();
              }
            }}
            placeholder="Add a comment... (Cmd+Enter to submit)"
            rows={3}
          />
          <div className="crispy-annotation-popover__actions">
            <button
              className="crispy-annotation-popover__cancel"
              onClick={cancelAnnotation}
            >
              Cancel
            </button>
            <button
              className="crispy-annotation-popover__submit"
              onClick={submitAnnotation}
            >
              Insert
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
