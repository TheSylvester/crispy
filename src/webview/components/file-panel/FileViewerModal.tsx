/**
 * FileViewerModal — modal overlay for file preview on the transcript area
 *
 * Renders when a file is opened from the file tree. Displays as a centered
 * modal over the transcript with close button and Escape-to-dismiss.
 * Supports text selection with a floating annotation popover — highlight text,
 * click Annotate, type a comment, and submit to insert into chat.
 *
 * @module file-panel/FileViewerModal
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFilePanel } from '../../context/FilePanelContext.js';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import { FileViewer } from './FileViewer.js';

/** Whether the file looks like a prompt/instruction file that can be executed */
function isExecutable(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}

/** Determine line numbers from a text selection within a code preview container */
function getLineRange(selectedText: string, fullContent: string): { start: number; end: number } | null {
  // Find the selected text in the full content
  const idx = fullContent.indexOf(selectedText);
  if (idx === -1) return null;
  const before = fullContent.slice(0, idx);
  const start = before.split('\n').length;
  const end = start + selectedText.split('\n').length - 1;
  return { start, end };
}

interface SelectionState {
  text: string;
  rect: DOMRect;
}

export function FileViewerModal(): React.JSX.Element | null {
  const { fileModalOpen, activeFileView, closeFile, insertIntoChat, loading, error } = useFilePanel();
  const envKind = useEnvironment();
  const modalRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationText, setAnnotationText] = useState('');

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (annotationMode) {
        setAnnotationMode(false);
        setAnnotationText('');
      } else if (selection) {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      } else {
        closeFile();
      }
    }
  }, [closeFile, annotationMode, selection]);

  useEffect(() => {
    if (!fileModalOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [fileModalOpen, handleKeyDown]);

  // Detect text selection within the modal body.
  // Only SET selection on valid text highlights — never auto-clear.
  // Selection is cleared explicitly via Escape, backdrop click, or modal close.
  useEffect(() => {
    if (!fileModalOpen || annotationMode) return;

    const handleMouseUp = () => {
      // Small delay to let browser finalize selection
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;

        const range = sel.getRangeAt(0);
        const text = sel.toString().trim();
        if (!text) return;

        // Only handle selections within the modal body (code preview area)
        const modal = modalRef.current;
        if (!modal) return;
        const body = modal.querySelector('.crispy-file-modal__body');
        if (!body || !body.contains(range.commonAncestorContainer)) {
          // Clicked outside the code area — clear selection
          setSelection(null);
          return;
        }

        const rect = range.getBoundingClientRect();

        // Store viewport-relative rect (popover uses position:fixed)
        setSelection({
          text,
          rect,
        });
      });
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [fileModalOpen, annotationMode]);

  // Focus textarea when annotation mode opens
  useEffect(() => {
    if (annotationMode && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [annotationMode]);

  // Clear state when modal closes
  useEffect(() => {
    if (!fileModalOpen) {
      setSelection(null);
      setAnnotationMode(false);
      setAnnotationText('');
    }
  }, [fileModalOpen]);

  const handleAnnotateClick = useCallback(() => {
    setAnnotationMode(true);
  }, []);

  const handleSubmitAnnotation = useCallback(() => {
    if (!activeFileView || !selection) return;

    const lineRange = getLineRange(selection.text, activeFileView.content);
    const lineRef = lineRange
      ? lineRange.start === lineRange.end
        ? `:${lineRange.start}`
        : `:${lineRange.start}-${lineRange.end}`
      : '';

    const comment = annotationText.trim();
    let annotation = `From \`${activeFileView.relativePath}${lineRef}\`:\n\`\`\`${activeFileView.language}\n${selection.text}\n\`\`\`\n`;
    if (comment) {
      annotation += `${comment}\n`;
    }

    insertIntoChat(annotation);
    setSelection(null);
    setAnnotationMode(false);
    setAnnotationText('');
    window.getSelection()?.removeAllRanges();
  }, [activeFileView, selection, annotationText, insertIntoChat]);

  const handleExecute = useCallback(() => {
    if (!activeFileView) return;
    if (envKind === 'websocket') {
      const key = `crispy-execute-${crypto.randomUUID()}`;
      sessionStorage.setItem(key, activeFileView.content);
      const url = new URL(window.location.pathname, window.location.origin);
      url.searchParams.set('execute', key);
      window.open(url.toString(), '_blank');
    } else {
      window.postMessage({ kind: 'executeInCrispy', content: activeFileView.content }, '*');
    }
    closeFile();
  }, [activeFileView, envKind, closeFile]);

  if (!fileModalOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      closeFile();
    }
  };

  const showExecute = activeFileView && isExecutable(activeFileView.relativePath);

  // Position the popover above the selection, centered horizontally
  const popoverStyle = selection ? {
    top: selection.rect.top - 8,
    left: selection.rect.left + selection.rect.width / 2,
  } : undefined;

  return (
    <>
    <div className="crispy-file-modal-backdrop" onClick={handleBackdropClick}>
      <div className="crispy-file-modal" ref={modalRef}>
        <div className="crispy-file-modal__header">
          <span className="crispy-file-modal__path">
            {activeFileView?.relativePath ?? (loading ? 'Loading...' : 'Error')}
          </span>
          {showExecute && (
            <button
              className="crispy-file-modal__execute"
              onClick={handleExecute}
              title="Open a new session with this file's content as the prompt"
              aria-label="Execute in Crispy"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 2L14 8L4 14Z" />
              </svg>
              <span>Execute</span>
            </button>
          )}
          <button
            className="crispy-file-modal__close"
            onClick={closeFile}
            aria-label="Close file viewer"
          >
            &times;
          </button>
        </div>
        <div className="crispy-file-modal__body">
          {activeFileView ? (
            <FileViewer file={activeFileView} error={error} loading={loading} />
          ) : loading ? (
            <div className="crispy-file-viewer">
              <div className="crispy-file-viewer__loading">Loading...</div>
            </div>
          ) : error ? (
            <div className="crispy-file-viewer">
              <div className="crispy-file-viewer__error">{error}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>

    {/* Portal the popover to document.body — escapes all stacking contexts */}
    {selection && createPortal(
        <div
          ref={popoverRef}
          className="crispy-annotation-popover"
          style={popoverStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {!annotationMode ? (
            <button
              className="crispy-annotation-popover__btn"
              onClick={handleAnnotateClick}
              title="Add an annotation to the selected text"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M14 1H2a1 1 0 00-1 1v8a1 1 0 001 1h3l3 3 3-3h3a1 1 0 001-1V2a1 1 0 00-1-1zM4 4h8v1H4V4zm0 3h6v1H4V7z" />
              </svg>
              <span>Annotate</span>
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
                    handleSubmitAnnotation();
                  }
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setAnnotationMode(false);
                    setAnnotationText('');
                  }
                }}
                placeholder="Add your annotation... (Cmd+Enter to submit)"
                rows={3}
              />
              <div className="crispy-annotation-popover__actions">
                <button
                  className="crispy-annotation-popover__cancel"
                  onClick={() => { setAnnotationMode(false); setAnnotationText(''); }}
                >
                  Cancel
                </button>
                <button
                  className="crispy-annotation-popover__submit"
                  onClick={handleSubmitAnnotation}
                >
                  Insert
                </button>
              </div>
            </div>
          )}
        </div>,
      document.body,
    )}
    </>
  );
}
