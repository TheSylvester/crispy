/**
 * FilePanel — file explorer view for the unified sidebar
 *
 * Renders in the same right-side panel space as BlocksToolPanel. Contains
 * header (title, count, refresh), search filter, scrollable file tree,
 * and context menu. Disabled/empty when no CWD selected.
 *
 * @module file-panel/FilePanel
 */

import { useState, useCallback } from 'react';
import { useFileTree } from '../../hooks/useFileTree.js';
import { useFilePanel } from '../../context/FilePanelContext.js';
import { useRefreshGitFiles } from '../../context/FileIndexContext.js';
import { useTabPanel } from '../../context/TabPanelContext.js';
import { FileTree } from './FileTree.js';
import { FileContextMenu } from './FileContextMenu.js';
import type { FileNode } from '../../hooks/useFileTree.js';

/** Refresh icon — circular arrow, 12x12 matching TitleBar icon style */
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
  const refreshGitFiles = useRefreshGitFiles();
  const { setToolPanelWidthPx } = useTabPanel();
  const { tree, expanded, toggleExpand, filter, setFilter, fileCount, loading } = useFileTree();
  const [contextMenu, setContextMenu] = useState<{ node: FileNode; x: number; y: number } | null>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const panel = (e.target as HTMLElement).closest('.crispy-file-panel');
    const startWidth = panel?.clientWidth ?? 350;
    const layout = panel?.closest('.crispy-tab-layout') ?? document.querySelector('.crispy-layout');

    layout?.setAttribute('data-resizing', '');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaPx = startX - moveEvent.clientX;
      setToolPanelWidthPx(Math.round(startWidth + deltaPx));
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
  }, [setToolPanelWidthPx]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    setContextMenu({ node, x: e.clientX, y: e.clientY });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  if (!cwd) {
    return (
      <div className="crispy-file-panel">
        <div
          className="crispy-tool-panel__resize-handle"
          onMouseDown={handleResizeStart}
        />
        <div className="crispy-file-panel__header">
          <span className="crispy-file-panel__title">FILES</span>
        </div>
        <div className="crispy-file-panel__empty">
          Select a project to browse files
        </div>
      </div>
    );
  }

  // Show last directory name from cwd for orientation
  const cwdLabel = cwd.split('/').filter(Boolean).pop() ?? cwd;

  return (
    <div className="crispy-file-panel">
      <div
        className="crispy-tool-panel__resize-handle"
        onMouseDown={handleResizeStart}
      />
      <div className="crispy-file-panel__header">
        <span className="crispy-file-panel__title" title={cwd}>{cwdLabel}</span>
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
