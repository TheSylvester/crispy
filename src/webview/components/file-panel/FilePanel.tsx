/**
 * FilePanel — root file explorer panel component
 *
 * Right-anchored side panel with header (title, count, refresh), search filter,
 * scrollable file tree, and context menu. Disabled/empty when no CWD selected.
 * Resize handle on the left edge. Stacks to the left of the tool panel.
 *
 * @module file-panel/FilePanel
 */

import { useState, useCallback } from 'react';
import { useFileTree } from '../../hooks/useFileTree.js';
import { useFilePanel } from '../../context/FilePanelContext.js';
import { usePreferences } from '../../context/PreferencesContext.js';
import { useRefreshGitFiles } from '../../context/FileIndexContext.js';
import { FileTree } from './FileTree.js';
import { FileContextMenu } from './FileContextMenu.js';
import type { FileNode } from '../../hooks/useFileTree.js';

/** Refresh icon — circular arrow, 12×12 matching TitleBar icon style */
function RefreshIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8a7 7 0 0 1 13.3-3M15 8a7 7 0 0 1-13.3 3" />
      <polyline points="1 3 1 8 6 8" />
      <polyline points="15 13 15 8 10 8" />
    </svg>
  );
}

export function FilePanel(): React.JSX.Element {
  const { cwd } = useFilePanel();
  const { setFilePanelWidthPx } = usePreferences();
  const refreshGitFiles = useRefreshGitFiles();
  const { tree, expanded, toggleExpand, filter, setFilter, fileCount, loading } = useFileTree();
  const [contextMenu, setContextMenu] = useState<{ node: FileNode; x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    setContextMenu({ node, x: e.clientX, y: e.clientY });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Drag-to-resize from the right edge
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const panel = (e.target as HTMLElement).closest('.crispy-file-panel');
    const startWidth = panel?.clientWidth ?? 260;
    const layout = document.querySelector('.crispy-layout');

    layout?.setAttribute('data-resizing', '');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaPx = startX - moveEvent.clientX;
      setFilePanelWidthPx(Math.round(startWidth + deltaPx));
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
  }, [setFilePanelWidthPx]);

  if (!cwd) {
    return (
      <div className="crispy-file-panel">
        <div className="crispy-file-panel__header">
          <span className="crispy-file-panel__title">FILES</span>
        </div>
        <div className="crispy-file-panel__empty">
          Select a project to browse files
        </div>
      </div>
    );
  }

  return (
    <div className="crispy-file-panel">
      <div className="crispy-file-panel__header">
        <span className="crispy-file-panel__title">FILES</span>
        <span className="crispy-file-panel__count">{fileCount}</span>
        <button className="crispy-file-panel__refresh-btn" onClick={refreshGitFiles} title="Refresh file list">
          <RefreshIcon />
        </button>
      </div>
      <div className="crispy-file-panel__search">
        <input
          type="text"
          className="crispy-file-panel__search-input"
          placeholder="Filter files..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="crispy-file-panel__scroll">
        {loading ? (
          <div className="crispy-file-panel__loading">Loading...</div>
        ) : (
          <FileTree
            nodes={tree}
            expanded={expanded}
            onToggle={toggleExpand}
            onContextMenu={handleContextMenu}
          />
        )}
      </div>
      <div className="crispy-file-panel__resize-handle" onMouseDown={handleResizeStart} />
      {contextMenu && (
        <FileContextMenu
          node={contextMenu.node}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={handleCloseContextMenu}
        />
      )}
    </div>
  );
}
