/**
 * FileViewerModal — modal overlay for file preview on the transcript area
 *
 * Renders when a file is opened from the file tree. Displays as a centered
 * modal over the transcript with close button and Escape-to-dismiss.
 * The file tree panel stays visible alongside the modal.
 *
 * @module file-panel/FileViewerModal
 */

import { useEffect, useCallback, useState } from 'react';
import { useFilePanel } from '../../context/FilePanelContext.js';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import { FileViewer } from './FileViewer.js';
import type { LineRange } from '../../renderers/tools/shared/CodePreview.js';

/** Whether the file looks like a prompt/instruction file that can be executed */
function isExecutable(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}

/** Extract selected lines from file content */
function extractLines(content: string, range: LineRange): string {
  const lines = content.split('\n');
  return lines.slice(range.start - 1, range.end).join('\n');
}

/** Format annotation as a code-fenced snippet with file path and line range */
function formatAnnotation(relativePath: string, language: string, content: string, range: LineRange): string {
  const snippet = extractLines(content, range);
  const lineRef = range.start === range.end
    ? `L${range.start}`
    : `L${range.start}-L${range.end}`;
  return `\`${relativePath}:${lineRef}\`:\n\`\`\`${language}\n${snippet}\n\`\`\`\n`;
}

export function FileViewerModal(): React.JSX.Element | null {
  const { fileModalOpen, activeFileView, closeFile, insertIntoChat, loading, error } = useFilePanel();
  const envKind = useEnvironment();
  const [selectedLines, setSelectedLines] = useState<LineRange | null>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeFile();
    }
  }, [closeFile]);

  useEffect(() => {
    if (!fileModalOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [fileModalOpen, handleKeyDown]);

  const handleExecute = useCallback(() => {
    if (!activeFileView) return;
    if (envKind === 'websocket') {
      // Dev server: stash content in sessionStorage (avoids URL length limits),
      // then open a new tab with a key reference. Same window.open() pattern as forkToNewPanel.
      const key = `crispy-execute-${crypto.randomUUID()}`;
      sessionStorage.setItem(key, activeFileView.content);
      const url = new URL(window.location.pathname, window.location.origin);
      url.searchParams.set('execute', key);
      window.open(url.toString(), '_blank');
    } else {
      // VS Code: post executeInCrispy message — the extension host opens a new panel.
      window.postMessage({ kind: 'executeInCrispy', content: activeFileView.content }, '*');
    }
    closeFile();
  }, [activeFileView, envKind, closeFile]);

  // Clear selection when modal closes
  useEffect(() => {
    if (!fileModalOpen) setSelectedLines(null);
  }, [fileModalOpen]);

  const handleAnnotate = useCallback(() => {
    if (!activeFileView || !selectedLines) return;
    const annotation = formatAnnotation(
      activeFileView.relativePath,
      activeFileView.language,
      activeFileView.content,
      selectedLines,
    );
    insertIntoChat(annotation);
    closeFile();
  }, [activeFileView, selectedLines, insertIntoChat, closeFile]);

  if (!fileModalOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      closeFile();
    }
  };

  const showExecute = activeFileView && isExecutable(activeFileView.relativePath);

  return (
    <div className="crispy-file-modal-backdrop" onClick={handleBackdropClick}>
      <div className="crispy-file-modal">
        <div className="crispy-file-modal__header">
          <span className="crispy-file-modal__path">
            {activeFileView?.relativePath ?? (loading ? 'Loading...' : 'Error')}
          </span>
          {selectedLines && (
            <button
              className="crispy-file-modal__annotate"
              onClick={handleAnnotate}
              title="Insert selected lines into the chat input"
              aria-label="Annotate selection"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M14 1H2a1 1 0 00-1 1v8a1 1 0 001 1h3l3 3 3-3h3a1 1 0 001-1V2a1 1 0 00-1-1zM4 4h8v1H4V4zm0 3h6v1H4V7z" />
              </svg>
              <span>
                Annotate {selectedLines.start === selectedLines.end
                  ? `L${selectedLines.start}`
                  : `L${selectedLines.start}-${selectedLines.end}`}
              </span>
            </button>
          )}
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
            <FileViewer
              file={activeFileView}
              error={error}
              loading={loading}
              selectable
              selectedLines={selectedLines}
              onLineSelect={setSelectedLines}
            />
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
  );
}
