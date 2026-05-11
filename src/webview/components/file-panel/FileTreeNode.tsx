/**
 * FileTreeNode — single node in the file tree (file or directory)
 *
 * Handles click (expand/select), right-click (context menu), and drag-start
 * (for drag-to-chat). Uses inline SVG icons for file types.
 *
 * @module file-panel/FileTreeNode
 */

import type { FileNode } from '../../hooks/useFileTree.js';
import { getFileIcon } from '../../utils/file-icons.js';

interface FileTreeNodeProps {
  node: FileNode;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  depth: number;
}

export function FileTreeNode({
  node,
  expanded,
  selected,
  onToggle,
  onSelect,
  onContextMenu,
  depth,
}: FileTreeNodeProps): React.JSX.Element {
  const isDir = node.kind === 'directory';
  const indent = depth * 16;
  const lastSlash = node.path.lastIndexOf('/');
  const parentPath = lastSlash >= 0 ? node.path.slice(0, lastSlash) : '';

  const handleClick = () => {
    if (isDir) {
      onToggle();
    } else {
      onSelect(node.path);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, node);
  };

  const handleDragStart = (e: React.DragEvent) => {
    if (isDir) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.setData('application/x-crispy-file', node.path);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div
      className={
        'crispy-file-node' +
        (selected ? ' crispy-file-node--selected' : '') +
        (isDir ? ' crispy-file-node--dir' : '')
      }
      style={{ paddingLeft: `${indent}px` }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      draggable={!isDir}
      onDragStart={handleDragStart}
      role="treeitem"
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={selected}
      tabIndex={0}
      data-drop-zone={isDir ? 'files-panel-folder' : 'files-panel-file'}
      data-path={isDir ? node.path : undefined}
      data-parent-path={!isDir ? parentPath : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      {isDir && (
        <span className={`crispy-file-node__chevron${expanded ? ' crispy-file-node__chevron--open' : ''}`}>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
            <path d="M2 1L6 4L2 7Z" />
          </svg>
        </span>
      )}
      {!isDir && <span className="crispy-file-node__spacer" />}
      {getFileIcon(node.name, isDir ? expanded : undefined)}
      <span className="crispy-file-node__name" title={node.path}>
        {node.name}
      </span>
    </div>
  );
}
