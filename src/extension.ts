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
  registerAdapter(
    claudeDiscovery,
    (sessionId) => new ClaudeAgentAdapter({ cwd, resume: sessionId, pathToClaudeCodeExecutable }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('crispy.open', () => openCrispyPanel(context)),
  );

  context.subscriptions.push({ dispose: () => unregisterAdapter('claude') });
}

export function deactivate(): void {}
