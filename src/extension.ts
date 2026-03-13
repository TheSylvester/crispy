/**
 * Crispy — VS Code Extension Entry Point
 *
 * Registers vendor adapters and the "Open Crispy" command.
 */

import * as vscode from 'vscode';

import { initSettings, startWatchingSettings, stopWatchingSettings } from './core/settings/index.js';
import { openCrispyPanel, getOrCreatePanelForPrefill, getMostRecentPanel, getActivePanel } from './host/webview-host.js';
import { startRescan, stopRescan } from './core/session-list-manager.js';
import { findClaudeBinary } from './core/find-claude-binary.js';
import { registerAllAdapters, resolveInternalServerPaths } from './host/adapter-registry.js';
import { createAgentDispatch } from './host/agent-dispatch.js';
import { initRosieBot, shutdownRosieBot } from './core/rosie/index.js';
import { initRecallIngest, shutdownRecallIngest } from './core/recall/ingest-hook.js';
import { startRecallCatchup, stopEmbeddingBackfill } from './core/recall/catchup-manager.js';
import { disposeEmbedder } from './core/recall/embedder.js';

export function activate(context: vscode.ExtensionContext): void {
  const bootStart = performance.now();
  function phase(name: string): () => void {
    const t0 = performance.now();
    console.log(`[crispy] > ${name}...`);
    return () => console.log(`[crispy] \u2713 ${name} (${(performance.now() - t0).toFixed(0)}ms)`);
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  // The extension build bundles the SDK into dist/extension.js, which breaks
  // the SDK's import.meta.url-based resolution of its bundled cli.js.
  // Instead of pointing at the SDK's cli.js (which causes `node cli.js`
  // spawning), find the native `claude` binary so the SDK runs it directly.
  let done = phase('findClaudeBinary');
  const pathToClaudeCodeExecutable = findClaudeBinary();
  done();
  if (!pathToClaudeCodeExecutable) {
    vscode.window.showWarningMessage(
      'Crispy: Claude Code not found. Claude sessions will be unavailable. Install Claude Code (https://docs.anthropic.com/en/docs/claude-code) and ensure `claude` is on your PATH.',
    );
  }

  // Create dispatch first — needed by adapter-registry for recall agent
  const dispatch = createAgentDispatch();

  // Register all available adapters (passes dispatch for recall tool)
  done = phase('registerAllAdapters');
  const disposeAdapters = registerAllAdapters({
    cwd,
    hostType: 'vscode',
    dispatch,
    extensionPath: context.extensionPath,
    ...(pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable }),
  });
  done();
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
      const panel = getActivePanel();
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

  // Wire up lifecycle hooks:
  //   Phase 0 (before): recall message ingest (lightweight SQLite indexing)
  //   Phase 2 (after): Rosie bot (summarize + tracker in two-turn child session)
  done = phase('initRecallIngest');
  initRecallIngest();
  done();
  // llama-embedding binary auto-downloads on first use (ensureBinary in embedder.ts)
  startRecallCatchup('vscode');
  done = phase('initRosieBot');
  initRosieBot(dispatch, resolveInternalServerPaths(context.extensionPath));
  done();
  context.subscriptions.push({
    dispose: () => {
      shutdownRosieBot();
      shutdownRecallIngest();
      stopEmbeddingBackfill();
      disposeEmbedder();
      dispatch.dispose();
    },
  });

  // Defer session list scan to next tick so the webview can initialize first
  setTimeout(startRescan, 0);
  context.subscriptions.push({ dispose: () => stopRescan() });

  context.subscriptions.push({ dispose: () => stopWatchingSettings() });

  console.log(`[crispy] activate() done (${(performance.now() - bootStart).toFixed(0)}ms)`);
}

export function deactivate(): void {}
