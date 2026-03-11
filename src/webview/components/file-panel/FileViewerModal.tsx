/**
 * FileViewerModal — modal overlay for file preview on the transcript area
 *
 * Renders when a file is opened from the file tree. Displays as a centered
 * modal over the transcript with close button and Escape-to-dismiss.
 * The file tree panel stays visible alongside the modal.
 *
 * @module file-panel/FileViewerModal
 */

import { useEffect, useCallback } from 'react';
import { useFilePanel } from '../../context/FilePanelContext.js';
import { useEnvironment } from '../../context/EnvironmentContext.js';
import { FileViewer } from './FileViewer.js';

/** Whether the file looks like a prompt/instruction file that can be executed */
function isExecutable(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}

export function FileViewerModal(): React.JSX.Element | null {
  const { fileModalOpen, activeFileView, closeFile, loading, error } = useFilePanel();
  const envKind = useEnvironment();

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
  );
}
