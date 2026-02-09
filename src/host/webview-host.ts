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

  // Nonce for CSP
  const nonce = getNonce();

  panel.webview.html = getWebviewHtml(panel.webview, scriptUri, cssUri, nonce);

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
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px;
    }

    .session-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .session-item {
      padding: 8px 12px;
      margin: 4px 0;
      cursor: pointer;
      border-radius: 4px;
      background: var(--vscode-list-hoverBackground);
      transition: background 0.1s;
    }

    .session-item:hover {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    h2 {
      font-weight: 600;
      margin: 0 0 8px;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
