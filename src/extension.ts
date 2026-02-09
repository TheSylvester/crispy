/**
 * Crispy — VS Code Extension Entry Point
 *
 * Registers the Claude adapter and the "Open Crispy" command.
 */

import * as vscode from 'vscode';
import { registerAdapter, unregisterAdapter } from './core/session-manager.js';
import { ClaudeAgentAdapter, claudeDiscovery } from './core/adapters/claude/claude-code-adapter.js';
import { createCrispyPanel } from './host/webview-host.js';

export function activate(context: vscode.ExtensionContext): void {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  registerAdapter(
    claudeDiscovery,
    (sessionId) => new ClaudeAgentAdapter({ cwd, resume: sessionId }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('crispy.open', () => createCrispyPanel(context)),
  );

  context.subscriptions.push({ dispose: () => unregisterAdapter('claude') });
}

export function deactivate(): void {}
