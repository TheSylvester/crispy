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
import { FileViewer } from './FileViewer.js';

export function FileViewerModal(): React.JSX.Element | null {
  const { fileModalOpen, activeFileView, closeFile, loading, error } = useFilePanel();

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

  if (!fileModalOpen) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      closeFile();
    }
  };

  return (
    <div className="crispy-file-modal-backdrop" onClick={handleBackdropClick}>
      <div className="crispy-file-modal">
        <div className="crispy-file-modal__header">
          <span className="crispy-file-modal__path">
            {activeFileView?.relativePath ?? (loading ? 'Loading...' : 'Error')}
          </span>
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
