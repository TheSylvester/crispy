/**
 * File Commands — static extensible command registry for the file context menu
 *
 * Commands are registered once at module load and never change at runtime.
 * The FileCommandContext is dynamic — built fresh each time the menu opens,
 * providing current transport, cwd, and callbacks from surrounding providers.
 *
 * @module file-panel/file-commands
 */

import type { FileNode } from '../../hooks/useFileTree.js';
import type { SessionService } from '../../transport.js';

// ============================================================================
// Types
// ============================================================================

export interface FileCommand {
  id: string;
  label: string;
  /** Menu group for separator placement */
  group: 'primary' | 'action' | 'clipboard';
  /** Which node kinds this command appears for */
  appliesTo: ('file' | 'directory')[];
  /** Optional keyboard shortcut hint shown in menu */
  shortcut?: string;
  /** Return false to hide this command for a given node */
  when?: (node: FileNode, context: FileCommandContext) => boolean;
  /** Execute the command */
  execute: (node: FileNode, context: FileCommandContext) => void | Promise<void>;
}

export interface FileCommandContext {
  transport: SessionService;
  cwd: string;
  /** Insert text into chat input at cursor position */
  insertIntoChat: (text: string) => void;
  /** Open file in the right panel's file viewer */
  openFile: (path: string, line?: number) => void;
}

// ============================================================================
// Registry
// ============================================================================

const commands: FileCommand[] = [];

export function registerFileCommand(cmd: FileCommand): void {
  commands.push(cmd);
}

export function getCommandsForNode(
  node: FileNode,
  context: FileCommandContext,
): FileCommand[] {
  return commands.filter(
    (cmd) =>
      cmd.appliesTo.includes(node.kind) &&
      (!cmd.when || cmd.when(node, context)),
  );
}

/** Get all unique groups in display order */
export function getGroupOrder(): string[] {
  return ['primary', 'action', 'clipboard'];
}

// ============================================================================
// Built-in Commands
// ============================================================================

// 1. Open File — files only
registerFileCommand({
  id: 'file.open',
  label: 'Open File',
  group: 'primary',
  appliesTo: ['file'],
  execute: (node, ctx) => ctx.openFile(node.path),
});

// 2. Copy Path — files and directories
registerFileCommand({
  id: 'file.copyPath',
  label: 'Copy Path',
  group: 'clipboard',
  appliesTo: ['file', 'directory'],
  shortcut: 'Ctrl+C',
  execute: (node) => navigator.clipboard.writeText(node.path),
});

// 3. Copy Absolute Path
registerFileCommand({
  id: 'file.copyAbsolutePath',
  label: 'Copy Absolute Path',
  group: 'clipboard',
  appliesTo: ['file', 'directory'],
  execute: (node, ctx) => navigator.clipboard.writeText(`${ctx.cwd}/${node.path}`),
});

// 4. Insert Path in Chat — files only
registerFileCommand({
  id: 'file.insertInChat',
  label: 'Insert in Chat',
  group: 'action',
  appliesTo: ['file'],
  execute: (node, ctx) => ctx.insertIntoChat(node.path),
});

// 5. Execute in Crispy — markdown files only
registerFileCommand({
  id: 'file.executeInCrispy',
  label: 'Execute in Crispy',
  group: 'action',
  appliesTo: ['file'],
  when: (node) => /\.(md|markdown)$/i.test(node.name),
  execute: async (node, ctx) => {
    const { content } = await ctx.transport.readFile(`${ctx.cwd}/${node.path}`);
    ctx.insertIntoChat(content);
  },
});
