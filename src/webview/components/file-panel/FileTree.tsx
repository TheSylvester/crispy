/**
 * FileTree — recursive tree renderer
 *
 * Renders a list of FileNode items, recursively expanding directories
 * that are in the expanded set.
 *
 * @module file-panel/FileTree
 */

import type { FileNode } from '../../hooks/useFileTree.js';
import { FileTreeNode } from './FileTreeNode.js';
import { useFilePanel } from '../../context/FilePanelContext.js';

interface FileTreeProps {
  nodes: FileNode[];
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}

export function FileTree({ nodes, expanded, onToggle, onContextMenu }: FileTreeProps): React.JSX.Element {
  const { activeFileView, openFile } = useFilePanel();
  const selectedPath = activeFileView?.relativePath ?? null;

  return (
    <div className="crispy-file-tree" role="tree">
      {nodes.map(node => (
        <FileTreeBranch
          key={node.path}
          node={node}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelect={openFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}

interface FileTreeBranchProps {
  node: FileNode;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}

function FileTreeBranch({
  node,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
  onContextMenu,
}: FileTreeBranchProps): React.JSX.Element {
  const isExpanded = node.kind === 'directory' && expanded.has(node.path);
  const isSelected = node.kind === 'file' && node.path === selectedPath;

  return (
    <>
      <FileTreeNode
        node={node}
        expanded={isExpanded}
        selected={isSelected}
        onToggle={() => onToggle(node.path)}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        depth={node.depth}
      />
      {isExpanded && node.children && node.children.map(child => (
        <FileTreeBranch
          key={child.path}
          node={child}
          expanded={expanded}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}
