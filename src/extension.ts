/**
 * Crispy — VS Code Extension Entry Point
 *
 * Registers vendor adapters and the "Open Crispy" command.
 */

import * as vscode from 'vscode';
import { registerAdapter, unregisterAdapter } from './core/session-manager.js';
import { ClaudeAgentAdapter, claudeDiscovery, getResumeModel } from './core/adapters/claude/claude-code-adapter.js';
import { CodexAgentAdapter, codexDiscovery } from './core/adapters/codex/index.js';
import { syncProviders, startWatching, stopWatching } from './core/provider-config.js';
import { openCrispyPanel, getOrCreatePanelForPrefill } from './host/webview-host.js';
import { startRescan, stopRescan } from './core/session-list-manager.js';
import { findClaudeBinary } from './core/find-claude-binary.js';
import { findCodexBinary } from './core/find-codex-binary.js';

export function activate(context: vscode.ExtensionContext): void {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  // The extension build bundles the SDK into dist/extension.js, which breaks
  // the SDK's import.meta.url-based resolution of its bundled cli.js.
  // Instead of pointing at the SDK's cli.js (which causes `node cli.js`
  // spawning), find the native `claude` binary so the SDK runs it directly.
  const pathToClaudeCodeExecutable = findClaudeBinary();
  if (!pathToClaudeCodeExecutable) {
    vscode.window.showWarningMessage(
      'Crispy: Claude Code not found. Claude sessions will be unavailable. Install Claude Code (https://docs.anthropic.com/en/docs/claude-code) and ensure `claude` is on your PATH.',
    );
  }

  // Register Claude adapter (conditional on binary being found)
  if (pathToClaudeCodeExecutable) {
    const base = { cwd, pathToClaudeCodeExecutable };
    registerAdapter(
      claudeDiscovery,
      (spec) => {
        switch (spec.mode) {
          case 'resume': {
            const model = getResumeModel(spec.sessionId);
            return new ClaudeAgentAdapter({ ...base, resume: spec.sessionId, ...(model && { model }) });
          }
          case 'fresh':
            return new ClaudeAgentAdapter({
              ...base, cwd: spec.cwd,
              ...(spec.model && { model: spec.model }),
              ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
              ...(spec.extraArgs && { extraArgs: spec.extraArgs }),
            });
          case 'fork':
            return new ClaudeAgentAdapter({
              ...base, resume: spec.fromSessionId, forkSession: true,
              ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
            });
          case 'continue':
            return new ClaudeAgentAdapter({ ...base, resume: spec.sessionId, continue: true });
          case 'hydrated':
            return new ClaudeAgentAdapter({
              ...base, cwd: spec.cwd,
              hydratedHistory: spec.history,
              ...(spec.model && { model: spec.model }),
              ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
            });
        }
      },
    );
    context.subscriptions.push({ dispose: () => unregisterAdapter('claude') });
  }

  // Register Codex adapter (conditional on binary being found)
  const pathToCodexExecutable = findCodexBinary();
  if (pathToCodexExecutable) {
    codexDiscovery.setCommand(pathToCodexExecutable);
    registerAdapter(
      codexDiscovery,
      (spec) => {
        const effectiveCwd = ('cwd' in spec) ? spec.cwd : cwd;
        return new CodexAgentAdapter({ ...spec, cwd: effectiveCwd, command: pathToCodexExecutable });
      },
    );
    context.subscriptions.push({ dispose: () => unregisterAdapter('codex') });
  }
  // No warning if Codex is missing — the dropdown shows it grayed out with "(not installed)".

  const workspaceOpts = { workspaceCwd: cwd };

  context.subscriptions.push(
    vscode.commands.registerCommand('crispy.editor.open', () => openCrispyPanel(context, workspaceOpts)),
    vscode.commands.registerCommand('crispy.executeFile', async (uri: vscode.Uri) => {
      if (!uri) return;
      const doc = await vscode.workspace.openTextDocument(uri);
      const content = doc.getText();
      if (!content.trim()) return;

      const panel = getOrCreatePanelForPrefill(context, workspaceOpts);
      // Small delay for newly created panels to initialize their webview JS
      setTimeout(() => {
        panel.webview.postMessage({ kind: 'executeInCrispy', content: `Execute the following:\n\n${content}` });
      }, 100);
    }),
  );

  // Register dynamic Anthropic-compatible providers from ~/.config/crispy/providers.json
  const providerBase = pathToClaudeCodeExecutable
    ? { cwd, pathToClaudeCodeExecutable }
    : { cwd };
  syncProviders(providerBase).catch((err) => console.error('[crispy] Failed to load providers:', err));
  startWatching(providerBase);

  startRescan();
  context.subscriptions.push({ dispose: () => stopRescan() });
  context.subscriptions.push({ dispose: () => stopWatching() });
}

export function deactivate(): void {}
