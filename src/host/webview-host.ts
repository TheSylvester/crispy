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
import { createMessageHandler } from './message-handler.js';

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

  panel.webview.html = getWebviewHtml(panel.webview, scriptUri, cssUri, stylesUri, nonce);

  // Wire up message handler
  const panelId = `panel-${Date.now()}`;
  const handler = createMessageHandler(panelId, (msg) => {
    panel.webview.postMessage(msg);
  });

  panel.webview.onDidReceiveMessage(
    (msg) => {
      // Handle VS Code-specific commands
      if (msg.kind === 'request' && msg.method === 'openFile') {
        const filePath = msg.params?.path as string;
        if (filePath) {
          vscode.window.showTextDocument(vscode.Uri.file(filePath));
        }
        return;
      }

      handler.handleMessage(msg).catch((err) => {
        console.error('[crispy] Message handler error:', err);
      });
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(() => {
    handler.dispose();
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
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';"
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
