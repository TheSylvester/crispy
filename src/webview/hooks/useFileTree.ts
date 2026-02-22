/**
 * useFileTree — transforms flat git file list into a renderable tree
 *
 * Consumes FileIndexContext's raw gitFiles[] and builds a hierarchical
 * FileNode[] tree. Handles expand/collapse state, substring filtering
 * (case-insensitive on pre-computed nameLower), and auto-expand of
 * common directories.
 *
 * Performance: buildTree runs once per file-list change (useMemo).
 * Filter uses useDeferredValue to avoid blocking the input.
 *
 * @module useFileTree
 */

import { useState, useMemo, useDeferredValue, useCallback, useEffect } from 'react';
import { useGitFiles } from '../context/FileIndexContext.js';
import { useCwd } from './useSessionCwd.js';

// ============================================================================
// Types
// ============================================================================

export interface FileNode {
  name: string;           // segment name ("components", "App.tsx")
  path: string;           // full relative path ("src/webview/components")
  kind: 'file' | 'directory';
  children?: FileNode[];  // sorted: directories first, then files, both alphabetical
  depth: number;
  /** Pre-computed lowercase name for filter matching */
  nameLower: string;
}

export interface UseFileTreeResult {
  tree: FileNode[];
  expanded: Set<string>;
  toggleExpand: (path: string) => void;
  expandTo: (filePath: string) => void;
  filter: string;
  setFilter: (text: string) => void;
  fileCount: number;
  loading: boolean;
  refresh: () => void;
}

// ============================================================================
// Auto-expand directories
// ============================================================================

/** Directories to auto-expand on initial build */
const AUTO_EXPAND_DIRS = new Set(['.ai-reference', 'src']);

// ============================================================================
// Tree building
// ============================================================================

interface MutableDir {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: string[];  // relative paths of files in this directory
  depth: number;
}

function buildTree(paths: string[]): { tree: FileNode[]; initialExpanded: Set<string> } {
  const root: MutableDir = { name: '', path: '', dirs: new Map(), files: [], depth: 0 };
  const initialExpanded = new Set<string>();

  for (const filePath of paths) {
    const segments = filePath.split('/');
    let current = root;

    // Walk/create directory nodes for all segments except the last (file name)
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let child = current.dirs.get(seg);
      if (!child) {
        const dirPath = segments.slice(0, i + 1).join('/');
        child = { name: seg, path: dirPath, dirs: new Map(), files: [], depth: i + 1 };
        current.dirs.set(seg, child);
      }
      current = child;
    }
    current.files.push(filePath);
  }

  // Auto-expand common directories
  for (const [name, dir] of root.dirs) {
    if (AUTO_EXPAND_DIRS.has(name)) {
      initialExpanded.add(dir.path);
    }
  }

  function toNodes(dir: MutableDir): FileNode[] {
    const nodes: FileNode[] = [];

    // Directories first (alphabetical)
    const sortedDirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of sortedDirs) {
      nodes.push({
        name: child.name,
        path: child.path,
        kind: 'directory',
        children: toNodes(child),
        depth: child.depth,
        nameLower: child.name.toLowerCase(),
      });
    }

    // Files (alphabetical)
    const fileNames = dir.files
      .map(fp => {
        const lastSlash = fp.lastIndexOf('/');
        return { name: lastSlash >= 0 ? fp.slice(lastSlash + 1) : fp, path: fp };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const f of fileNames) {
      nodes.push({
        name: f.name,
        path: f.path,
        kind: 'file',
        depth: dir.depth + 1,
        nameLower: f.name.toLowerCase(),
      });
    }

    return nodes;
  }

  return { tree: toNodes(root), initialExpanded };
}

// ============================================================================
// Tree filtering
// ============================================================================

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  if (!query) return nodes;
  const lower = query.toLowerCase();

  function filterNode(node: FileNode): FileNode | null {
    if (node.kind === 'file') {
      // Match file name (not full path) for simplicity
      return node.nameLower.includes(lower) ? node : null;
    }

    // Directory: include if any children match
    const filteredChildren = node.children
      ? node.children.map(filterNode).filter((n): n is FileNode => n !== null)
      : [];

    if (filteredChildren.length === 0) return null;

    return { ...node, children: filteredChildren };
  }

  return nodes.map(filterNode).filter((n): n is FileNode => n !== null);
}

/** Count files in a filtered tree */
function countFiles(nodes: FileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind === 'file') {
      count++;
    } else if (node.children) {
      count += countFiles(node.children);
    }
  }
  return count;
}

// ============================================================================
// Hook
// ============================================================================

export function useFileTree(): UseFileTreeResult {
  const gitFiles = useGitFiles();
  const { fullPath } = useCwd();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Build tree from flat file list (runs once per file-list change)
  const { tree, initialExpanded } = useMemo(() => {
    if (!gitFiles || gitFiles.length === 0) {
      return { tree: [] as FileNode[], initialExpanded: new Set<string>() };
    }
    return buildTree(gitFiles);
  }, [gitFiles]);

  // Set initial expanded state when tree is first built or CWD changes
  useEffect(() => {
    if (initialExpanded.size > 0) {
      setExpanded(initialExpanded);
    } else {
      setExpanded(new Set());
    }
    setFilter('');
  }, [fullPath, initialExpanded]);

  // Apply filter
  const filteredTree = useMemo(
    () => filterTree(tree, deferredFilter),
    [tree, deferredFilter],
  );

  const fileCount = useMemo(() => countFiles(filteredTree), [filteredTree]);

  const toggleExpand = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const expandTo = useCallback((filePath: string) => {
    // Expand all ancestor directories of the given file path
    const segments = filePath.split('/');
    setExpanded(prev => {
      const next = new Set(prev);
      for (let i = 1; i < segments.length; i++) {
        next.add(segments.slice(0, i).join('/'));
      }
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    setRefreshTrigger(c => c + 1);
  }, []);

  // Consume refreshTrigger to avoid lint warnings — the actual refresh
  // happens via useRefreshGitFiles in the FilePanel component
  void refreshTrigger;

  return {
    tree: filteredTree,
    expanded,
    toggleExpand,
    expandTo,
    filter,
    setFilter,
    fileCount,
    loading: gitFiles === null,
    refresh,
  };
}
