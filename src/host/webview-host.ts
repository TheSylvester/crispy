/**
 * Webview Host — VS Code Webview Panel + postMessage Bridge
 *
 * Creates a VS Code WebviewPanel and bridges it to the session-manager
 * via createMessageHandler(). The webview loads the same bundle as the
 * Chrome dev server, but communicates via postMessage instead of WebSocket.
 *
 * @module webview-host
 */

import * as vscode from 'vscode';
import { createMessageHandler, type HostMessage } from './message-handler.js';

/** The single active Crispy panel, if any. */
let activePanel: vscode.WebviewPanel | undefined;

/** Monotonic counter for panel client IDs (mirrors dev-server connectionCounter). */
let panelCounter = 0;

/**
 * Open the Crispy panel (or reveal + focus input if already open).
 *
 * @param context  VS Code extension context (for webview resource URIs)
 */
export function openCrispyPanel(context: vscode.ExtensionContext): void {
  if (activePanel) {
    activePanel.reveal(undefined, false);
    activePanel.webview.postMessage({ kind: 'focusInput' });
    return;
  }
  createCrispyPanel(context);
}

/**
 * Create and show a Crispy webview panel.
 *
 * @param context  VS Code extension context (for webview resource URIs)
 */
export function createCrispyPanel(
  context: vscode.ExtensionContext,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'crispy',
    'Crispy',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
      ],
    },
  );

  // Resolve URIs for webview resources
  const webviewDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDir, 'main.js'),
  );
  const cssUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDir, 'theme-defaults.css'),
  );
  const stylesUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDir, 'styles.css'),
  );

  // Nonce for CSP
  const nonce = getNonce();

  // --- Core bridge (mirrors dev-server.ts wss.on('connection') pattern) ---

  const panelId = `vscode-panel-${++panelCounter}`;
  let disposed = false;

  // Guarded sendFn — mirrors dev-server's `if (ws.readyState === ws.OPEN)` check
  const handler = createMessageHandler(panelId, (msg) => {
    if (!disposed) {
      panel.webview.postMessage(msg);
    }
  });

  // Wire listener BEFORE setting HTML to prevent race condition.
  // The dev-server has no race because ws.on('message') is registered
  // synchronously inside the 'connection' callback before any data arrives.
  panel.webview.onDidReceiveMessage(
    (msg) => {
      // VS Code-specific: open file in editor (requires vscode API,
      // so handled here rather than in shared message-handler)
      if (msg.kind === 'request' && msg.method === 'openFile') {
        const filePath = msg.params?.path as string;
        if (filePath) {
          vscode.window.showTextDocument(vscode.Uri.file(filePath));
        }
        // Always send response so client's pending request resolves
        if (!disposed) {
          panel.webview.postMessage({
            kind: 'response',
            id: msg.id,
            result: { opened: !!filePath },
          } satisfies HostMessage);
        }
        return;
      }

      handler.handleMessage(msg).catch((err) => {
        console.error(`[crispy] Message handler error (${panelId}):`, err);
      });
    },
    undefined,
    context.subscriptions,
  );

  // Set HTML AFTER listener is wired — this triggers webview JS to load
  panel.webview.html = getWebviewHtml(panel.webview, scriptUri, cssUri, stylesUri, nonce);

  activePanel = panel;

  panel.onDidDispose(() => {
    disposed = true;
    handler.dispose();
    activePanel = undefined;
  });

  return panel;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function getWebviewHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  cssUri: vscode.Uri,
  stylesUri: vscode.Uri,
  nonce: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} blob:; font-src ${webview.cspSource};"
  >
  <title>Crispy</title>
  <link rel="stylesheet" href="${cssUri}">
  <link rel="stylesheet" href="${stylesUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
