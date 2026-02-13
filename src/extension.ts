/**
 * Crispy — VS Code Extension Entry Point
 *
 * Registers the Claude adapter and the "Open Crispy" command.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerAdapter, unregisterAdapter } from './core/session-manager.js';
import { ClaudeAgentAdapter, claudeDiscovery } from './core/adapters/claude/claude-code-adapter.js';
import { openCrispyPanel } from './host/webview-host.js';
import { startRescan, stopRescan } from './core/session-list-manager.js';

export function activate(context: vscode.ExtensionContext): void {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  // The extension build bundles the SDK into dist/extension.js, which breaks
  // the SDK's import.meta.url-based resolution of its bundled cli.js.
  // Resolve the path explicitly from the installed node_modules, just like
  // Leto does (see leto/src/extension.ts).
  const pathToClaudeCodeExecutable = path.join(
    context.extensionPath,
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'cli.js',
  );
  const base = { cwd, pathToClaudeCodeExecutable };
  registerAdapter(
    claudeDiscovery,
    (spec) => {
      switch (spec.mode) {
        case 'resume':
          return new ClaudeAgentAdapter({ ...base, resume: spec.sessionId });
        case 'fresh':
          return new ClaudeAgentAdapter({
            ...base, cwd: spec.cwd,
            ...(spec.model && { model: spec.model }),
            ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          });
        case 'fork':
          return new ClaudeAgentAdapter({
            ...base, resume: spec.fromSessionId, forkSession: true,
            ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
          });
        case 'continue':
          return new ClaudeAgentAdapter({ ...base, resume: spec.sessionId, continue: true });
      }
    },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('crispy.editor.open', () => openCrispyPanel(context)),
  );

  startRescan();
  context.subscriptions.push({ dispose: () => stopRescan() });
  context.subscriptions.push({ dispose: () => unregisterAdapter('claude') });
}

export function deactivate(): void {}
