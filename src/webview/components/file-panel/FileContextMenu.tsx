/**
 * FileContextMenu — right-click context menu overlay
 *
 * Positioned at cursor coordinates, rendered via React portal to document.body
 * to avoid scroll container clipping. Dismisses on click-outside, Escape, or
 * scroll. Groups commands with separators, supports keyboard navigation.
 *
 * @module file-panel/FileContextMenu
 */

import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileNode } from '../../hooks/useFileTree.js';
import { useTransport } from '../../context/TransportContext.js';
import { useFilePanel } from '../../context/FilePanelContext.js';
import { useIsActiveTab } from '../../context/TabContainerContext.js';
import {
  getCommandsForNode,
  getGroupOrder,
  type FileCommand,
  type FileCommandContext,
} from './file-commands.js';

interface FileContextMenuProps {
  node: FileNode;
  position: { x: number; y: number };
  onClose: () => void;
}

export function FileContextMenu({ node, position, onClose }: FileContextMenuProps): React.JSX.Element {
  const transport = useTransport();
  const { cwd, openFile, insertIntoChat } = useFilePanel();
  const isActiveTab = useIsActiveTab();
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIdx, setFocusedIdx] = useState(0);

  // Close menu when tab becomes inactive — prevents portal from surviving tab switch
  useEffect(() => {
    if (!isActiveTab) onClose();
  }, [isActiveTab, onClose]);

  const context: FileCommandContext = useMemo(
    () => ({ transport, cwd: cwd!, openFile, insertIntoChat }),
    [transport, cwd, openFile, insertIntoChat],
  );

  const commands = useMemo(
    () => getCommandsForNode(node, context),
    [node, context],
  );

  // Group commands for rendering with separators
  const groupedItems = useMemo(() => {
    const groupOrder = getGroupOrder();
    const result: Array<{ type: 'command'; cmd: FileCommand; index: number } | { type: 'separator' }> = [];
    let globalIdx = 0;
    let addedGroup = false;

    for (const group of groupOrder) {
      const groupCmds = commands.filter(c => c.group === group);
      if (groupCmds.length === 0) continue;

      if (addedGroup) {
        result.push({ type: 'separator' });
      }
      for (const cmd of groupCmds) {
        result.push({ type: 'command', cmd, index: globalIdx++ });
      }
      addedGroup = true;
    }
    return result;
  }, [commands]);

  const commandCount = commands.length;

  // Position adjustment to avoid viewport overflow
  const [adjustedPos, setAdjustedPos] = useState(position);
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = position;
    if (x + rect.width > vw - 8) x = vw - rect.width - 8;
    if (y + rect.height > vh - 8) y = vh - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setAdjustedPos({ x, y });
  }, [position]);

  // Click-outside and Escape dismissal
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    // Use capture phase for click-outside so it fires before anything else
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIdx(prev => (prev + 1) % commandCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIdx(prev => (prev - 1 + commandCount) % commandCount);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = commands[focusedIdx];
      if (cmd) {
        cmd.execute(node, context);
        onClose();
      }
    }
  }, [commandCount, commands, focusedIdx, node, context, onClose]);

  const handleItemClick = useCallback((cmd: FileCommand) => {
    cmd.execute(node, context);
    onClose();
  }, [node, context, onClose]);

  if (commands.length === 0) return createPortal(null, document.body);

  return createPortal(
    <div
      ref={menuRef}
      className="crispy-file-ctx-menu"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="menu"
    >
      {groupedItems.map((item, i) => {
        if (item.type === 'separator') {
          return <div key={`sep-${i}`} className="crispy-file-ctx-menu__sep" role="separator" />;
        }
        const { cmd, index } = item;
        const isFocused = index === focusedIdx;
        return (
          <button
            key={cmd.id}
            className={`crispy-file-ctx-menu__item${isFocused ? ' crispy-file-ctx-menu__item--focused' : ''}`}
            onClick={() => handleItemClick(cmd)}
            onMouseEnter={() => setFocusedIdx(index)}
            role="menuitem"
            tabIndex={-1}
          >
            <span className="crispy-file-ctx-menu__label">{cmd.label}</span>
            {cmd.shortcut && (
              <span className="crispy-file-ctx-menu__shortcut">{cmd.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
