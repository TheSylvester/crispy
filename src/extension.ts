/**
 * Crispy — VS Code Extension Entry Point
 *
 * Registers vendor adapters and the "Open Crispy" command.
 */

import * as vscode from 'vscode';
import { initSettings, startWatchingSettings, stopWatchingSettings } from './core/settings/index.js';
import { openCrispyPanel, getOrCreatePanelForPrefill, getMostRecentPanel } from './host/webview-host.js';
import { startRescan, stopRescan } from './core/session-list-manager.js';
import { runScan } from './core/activity-scanner.js';
import { findClaudeBinary } from './core/find-claude-binary.js';
import { registerAllAdapters, resolveInternalServerPaths } from './host/adapter-registry.js';
import { createAgentDispatch } from './host/agent-dispatch.js';
import { initRosieSummarize, shutdownRosieSummarize, initRosieTracker, shutdownRosieTracker } from './core/rosie/index.js';

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

  // Create dispatch first — needed by adapter-registry for recall agent
  const dispatch = createAgentDispatch();

  // Register all available adapters (passes dispatch for recall tool)
  const disposeAdapters = registerAllAdapters({
    cwd,
    hostType: 'vscode',
    dispatch,
    extensionPath: context.extensionPath,
    ...(pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable }),
  });
  context.subscriptions.push({ dispose: disposeAdapters });

  const workspaceOpts = { workspaceCwd: cwd };

  context.subscriptions.push(
    vscode.commands.registerCommand('crispy.editor.open', () => openCrispyPanel(context, workspaceOpts)),
    vscode.commands.registerCommand('crispy.focus', () => openCrispyPanel(context, workspaceOpts)),
    vscode.commands.registerCommand('crispy.blur', () => vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')),
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
    vscode.commands.registerCommand('crispy.toggleVoiceInput', () => {
      const panel = getMostRecentPanel();
      if (panel) {
        panel.webview.postMessage({ kind: 'toggleVoiceInput' });
      }
    }),
  );

  // Initialize settings from ~/.config/crispy/settings.json
  const providerBase = pathToClaudeCodeExecutable
    ? { cwd, pathToClaudeCodeExecutable }
    : { cwd };
  initSettings(providerBase).catch((err) => console.error('[crispy] Failed to load settings:', err));
  startWatchingSettings();

  // Wire up Rosie hooks (tracker phase-2 fires after summarize phase-1)
  initRosieSummarize(dispatch);
  initRosieTracker(dispatch, resolveInternalServerPaths(context.extensionPath));
  context.subscriptions.push({
    dispose: () => {
      shutdownRosieTracker();
      shutdownRosieSummarize();
      dispatch.dispose();
    },
  });

  startRescan();
  context.subscriptions.push({ dispose: () => stopRescan() });

  // Activity scanning — index user prompts for the Activity Path view
  const safeRunScan = () => {
    try { runScan(); } catch (err) { console.error('[crispy] Activity scan failed:', err); }
  };
  setImmediate(safeRunScan);
  const scanTimer = setInterval(safeRunScan, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(scanTimer) });
  context.subscriptions.push({ dispose: () => stopWatchingSettings() });
}

export function deactivate(): void {}
