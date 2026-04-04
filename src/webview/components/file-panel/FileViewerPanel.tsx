/**
 * FileViewerPanel — persistent panel for file preview alongside the sidebar
 *
 * Renders as a fixed-position panel to the left of the sidebar (Files/Tools).
 * Replaces the old FileViewerModal lightbox. Supports text selection with a
 * floating annotation popover (portaled to document.body), Execute button
 * for prompt files, scroll-to-line via targetLine, and Escape cascade
 * (annotation → selection → close panel).
 *
 * @module file-panel/FileViewerPanel
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFilePanel } from '../../context/FilePanelContext.js';
import { useTabPanel } from '../../context/TabPanelContext.js';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import { FileViewer } from './FileViewer.js';

/** Whether the file looks like a prompt/instruction file that can be executed */
function isExecutable(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}

/** Determine line numbers from a text selection within a code preview container */
function getLineRange(selectedText: string, fullContent: string): { start: number; end: number } | null {
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

export function FileViewerPanel(): React.JSX.Element | null {
  const { fileViewerOpen, activeFileView, closeFile, insertIntoChat, loading, error } = useFilePanel();
  const { setFileViewerWidthPx } = useTabPanel();
  const envKind = useEnvironment();
  const panelRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const [wordWrap, setWordWrap] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(true);

  // Auto-enable markdown preview for .md files, disable for others
  const isMarkdownFile = activeFileView ? /\.(md|markdown)$/i.test(activeFileView.relativePath) : false;
  useEffect(() => {
    setMarkdownPreview(isMarkdownFile);
  }, [isMarkdownFile]);

  // Escape cascade: annotation → selection → close panel
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
    if (!fileViewerOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [fileViewerOpen, handleKeyDown]);

  // Detect text selection within the panel body
  useEffect(() => {
    if (!fileViewerOpen || annotationMode) return;

    const handleMouseUp = () => {
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;

        const range = sel.getRangeAt(0);
        const text = sel.toString().trim();
        if (!text) return;

        // Only handle selections within the panel body (code preview area)
        const panel = panelRef.current;
        if (!panel) return;
        const body = panel.querySelector('.crispy-file-viewer-panel__body');
        if (!body || !body.contains(range.commonAncestorContainer)) {
          setSelection(null);
          return;
        }

        const rect = range.getBoundingClientRect();
        setSelection({ text, rect });
      });
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [fileViewerOpen, annotationMode]);

  // Focus textarea when annotation mode opens
  useEffect(() => {
    if (annotationMode && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [annotationMode]);

  // Clear state when panel closes
  useEffect(() => {
    if (!fileViewerOpen) {
      setSelection(null);
      setAnnotationMode(false);
      setAnnotationText('');
    }
  }, [fileViewerOpen]);

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
    let annotation = `From \`${activeFileView.relativePath}${lineRef}\`:\n\`\`\`\`${activeFileView.language}\n${selection.text}\n\`\`\`\`\n`;
    if (comment) {
      annotation += `* ${comment}\n`;
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

  // Drag-to-resize (left edge)
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const panel = (e.target as HTMLElement).closest('.crispy-file-viewer-panel');
    const startWidth = panel?.clientWidth ?? 350;
    const layout = document.querySelector('.crispy-layout');

    layout?.setAttribute('data-resizing', '');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaPx = startX - moveEvent.clientX;
      setFileViewerWidthPx(Math.round(startWidth + deltaPx));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      layout?.removeAttribute('data-resizing');
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [setFileViewerWidthPx]);

  if (!fileViewerOpen) return null;

  const showExecute = activeFileView && isExecutable(activeFileView.relativePath);

  // Position the popover above the selection, centered horizontally
  const popoverStyle = selection ? {
    top: selection.rect.top - 8,
    left: selection.rect.left + selection.rect.width / 2,
  } : undefined;

  return (
    <>
    <div className="crispy-file-viewer-panel" ref={panelRef}>
      <div
        className="crispy-tool-panel__resize-handle"
        onMouseDown={handleResizeStart}
      />
      <div className="crispy-file-viewer-panel__header">
        <span className="crispy-file-viewer-panel__path">
          {activeFileView?.relativePath ?? (loading ? 'Loading...' : 'Error')}
        </span>
        <div className="crispy-file-viewer-panel__toolbar">
          {activeFileView && (
            <>
              <button
                className={`crispy-file-viewer-panel__toolbar-btn${wordWrap ? ' crispy-file-viewer-panel__toolbar-btn--active' : ''}`}
                onClick={() => setWordWrap(w => !w)}
                title="Toggle word wrap"
                aria-label="Toggle word wrap"
              >
                Wrap
              </button>
              {isMarkdownFile && (
                <button
                  className={`crispy-file-viewer-panel__toolbar-btn${markdownPreview ? ' crispy-file-viewer-panel__toolbar-btn--active' : ''}`}
                  onClick={() => setMarkdownPreview(p => !p)}
                  title="Toggle markdown preview"
                  aria-label="Toggle markdown preview"
                >
                  Preview
                </button>
              )}
            </>
          )}
          {showExecute && (
            <button
              className="crispy-file-viewer-panel__execute"
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
        </div>
        <button
          className="crispy-file-viewer-panel__close"
          onClick={closeFile}
          aria-label="Close file viewer"
          title="Close file viewer (Alt+V)"
        >
          &times;
        </button>
      </div>
      <div className="crispy-file-viewer-panel__body">
        {activeFileView ? (
          <FileViewer file={activeFileView} error={error} loading={loading} wordWrap={wordWrap} markdownPreview={markdownPreview} />
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
                    handleSubmitAnnotation();
                  }
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setAnnotationMode(false);
                    setAnnotationText('');
                  }
                }}
                placeholder="Add a comment... (Cmd+Enter to submit)"
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
