/**
 * Crispy — VS Code Extension Entry Point
 *
 * Registers vendor adapters and the "Open Crispy" command.
 */

import * as vscode from 'vscode';

import { initSettings, startWatchingSettings, stopWatchingSettings } from './core/settings/index.js';
import { openCrispyPanel, getOrCreatePanelForPrefill, getMostRecentPanel, getActivePanel, createCrispyPanel, getPanelHostingSession } from './host/webview-host.js';
import { OpenSessionsViewProvider } from './host/sessions-sidebar-view.js';
import { registerPanelOpener, registerPanelCloser } from './host/panel-opener.js';
import { startRescan, stopRescan } from './core/session-list-manager.js';
import { findClaudeBinary } from './core/find-claude-binary.js';
import { registerAllAdapters } from './host/adapter-registry.js';
import { createAgentDispatch } from './host/agent-dispatch.js';
import { initRosieBot, shutdownRosieBot } from './core/rosie/index.js';
import { initMessageView, shutdownMessageView } from './core/message-view/index.js';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { initRecallIngest, shutdownRecallIngest } from './core/recall/ingest-hook.js';
import { startRecallCatchup, stopEmbeddingBackfill } from './core/recall/catchup-manager.js';
import { disposeEmbedder } from './core/recall/embedder.js';
import { startIpcServer, getSocketPath } from './host/ipc-server.js';
import { setHostSocketPath, setDefaultCwd, closeSession } from './core/session-manager.js';

export function activate(context: vscode.ExtensionContext): void {
  const bootStart = performance.now();
  function phase(name: string): () => void {
    const t0 = performance.now();
    console.log(`[crispy] > ${name}...`);
    return () => console.log(`[crispy] \u2713 ${name} (${(performance.now() - t0).toFixed(0)}ms)`);
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();

  // VS Code on Windows may return \\?\ UNC-prefixed paths from extensionPath.
  // These break when passed through bash env vars to Node.js child processes.
  const extPath = context.extensionPath.replace(/^\\\\\?\\/, '');

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
    extensionPath: extPath,
    ...(pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable }),
  });
  done();
  context.subscriptions.push({ dispose: disposeAdapters });

  setDefaultCwd(cwd);
  setHostSocketPath(getSocketPath(undefined, 'server'));

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
      // Retry with increasing delays — FlexLayout + React init can exceed 100ms
      const msg = { kind: 'executeInCrispy', content: `Execute the following:\n\n${content}` };
      for (const delay of [200, 600, 1500]) {
        setTimeout(() => panel.webview.postMessage(msg), delay);
      }
    }),
    vscode.commands.registerCommand('crispy.toggleVoiceInput', () => {
      const panel = getActivePanel();
      if (panel) {
        panel.webview.postMessage({ kind: 'toggleVoiceInput' });
      }
    }),
  );

  // Open Sessions sidebar view (Activity Bar)
  const sidebarProvider = new OpenSessionsViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OpenSessionsViewProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Initialize settings from settingsPath() (platform-dependent: ~/.crispy/ or %APPDATA%/Crispy/)
  const providerBase = pathToClaudeCodeExecutable
    ? { cwd, pathToClaudeCodeExecutable }
    : { cwd };
  initSettings(providerBase)
    .then(() => {
      // Message view reads settings on init — must come after settings are loaded
      const mvDone = phase('initMessageView');
      initMessageView(dispatch, cwd, 'vscode');
      mvDone();
    })
    .catch((err) => console.error('[crispy] Failed to load settings:', err));
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
  initRosieBot(dispatch, {
    trackerScript: resolve(extPath, 'dist', 'crispy-tracker.mjs'),
    ipcSocket: getSocketPath(undefined, 'server'),
  });
  done();
  context.subscriptions.push({
    dispose: () => {
      shutdownMessageView();
      shutdownRosieBot();
      shutdownRecallIngest();
      stopEmbeddingBackfill();
      disposeEmbedder();
      dispatch.dispose();
    },
  });

  // Register panel opener/closer so CLI callers (ipc-server) can open/close VS Code panels.
  //
  // Panel→session lookup:
  // - Opener: `getPanelHostingSession` walks the session-channel's subscribers
  //   to find ANY panel hosting the session (includes regular Crispy panels
  //   with FlexLayout tabs, not just dedicated openPanel-spawned ones).
  // - `dedicatedPanels` Map tracks panels created BY this opener — used for
  //   (a) the closer (only dispose dedicated panels, not multi-tab hosts) and
  //   (b) autoClose dispose semantics (CLI panels reap the session on close).
  //   Also a fast-path for rapid sidebar re-clicks before the new panel's
  //   webview has finished subscribing to the channel.
  const dedicatedPanels = new Map<string, vscode.WebviewPanel>();

  registerPanelOpener((sessionId, options) => {
    const dedicated = dedicatedPanels.get(sessionId);
    if (dedicated) {
      // Fast path — covers rapid re-clicks before subscription completes,
      // and stale mappings if user switched the panel to another session
      // via the dropdown. navigateToSession is harmless for fresh panels
      // (the openSession bootstrap drives the initial tab) and re-syncs
      // FlexLayout to the right tab if the panel drifted.
      dedicated.reveal(undefined, false);
      dedicated.webview.postMessage({ kind: 'navigateToSession', sessionId });
      return;
    }
    const existing = getPanelHostingSession(sessionId);
    if (existing) {
      existing.reveal(undefined, false);
      // Multi-tab Crispy panels need to switch the inner FlexLayout tab
      existing.webview.postMessage({ kind: 'navigateToSession', sessionId });
      return;
    }
    const column = options?.autoClose
      ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
      : vscode.ViewColumn.Beside;
    const panel = createCrispyPanel(context, column, { autoClose: options?.autoClose });
    dedicatedPanels.set(sessionId, panel);
    panel.onDidDispose(() => {
      if (dedicatedPanels.get(sessionId) === panel) {
        dedicatedPanels.delete(sessionId);
        // autoClose panels are lifecycle-owned (CLI/observer): closing the
        // panel reaps the channel. maybeScheduleReap skips child sessions,
        // so we must close them explicitly here. Sidebar-peek panels
        // (no autoClose) are non-owning views — closing must not kill the agent.
        if (options?.autoClose) closeSession(sessionId);
      }
    });
    const msg = { kind: 'openSession', sessionId };
    for (const delay of [100, 500, 1500]) {
      setTimeout(() => panel.webview.postMessage(msg), delay);
    }
  });

  registerPanelCloser((sessionId) => {
    // Only dispose panels we created dedicated for this session. Multi-tab
    // Crispy panels that happen to be subscribed handle session_close_channel
    // themselves via the webview-side FlexLayout listener.
    const panel = dedicatedPanels.get(sessionId);
    if (!panel) return false;
    panel.dispose();
    return true;
  });

  // Defer session list scan to next tick so the webview can initialize first
  setTimeout(startRescan, 0);
  context.subscriptions.push({ dispose: () => stopRescan() });

  context.subscriptions.push({ dispose: () => stopWatchingSettings() });

  // Start IPC server for CLI dispatch (Unix socket / Windows named pipe)
  startIpcServer(cwd)
    .then((ipc) => {
      context.subscriptions.push({ dispose: () => ipc.close() });
    })
    .catch((err) => console.error('[crispy] IPC server failed to start:', err));

  console.log(`[crispy] activate() done (${(performance.now() - bootStart).toFixed(0)}ms)`);
}

export function deactivate(): void {}
