/**
 * Webview Host — VS Code Webview Panel + postMessage Bridge
 *
 * Creates VS Code WebviewPanels and bridges them to the session-manager
 * via createClientConnection(). Supports multi-window panel management:
 * - No panels exist → create new panel in current editor column
 * - Panel exists but not focused → reveal most recent panel
 * - Panel is focused → create new panel beside it
 *
 * @module webview-host
 */

import * as vscode from 'vscode';
import { createClientConnection, type HostMessage } from './client-connection.js';

/** All active Crispy panels, keyed by panelId. */
const panels = new Map<string, vscode.WebviewPanel>();

/** Monotonic counter for panel client IDs (mirrors dev-server connectionCounter). */
let panelCounter = 0;

/**
 * Check if any Crispy panel is currently focused.
 */
function isAnyPanelActive(): boolean {
  for (const panel of panels.values()) {
    if (panel.active) return true;
  }
  return false;
}

/**
 * Get the most recently created panel (last in insertion order).
 */
function getMostRecentPanel(): vscode.WebviewPanel | undefined {
  const all = Array.from(panels.values());
  return all[all.length - 1];
}

/**
 * Get or create a panel for prefilling input content.
 * Unlike openCrispyPanel, this always returns the panel reference
 * and reuses the existing panel instead of creating one beside it.
 */
export function getOrCreatePanelForPrefill(
  context: vscode.ExtensionContext,
): vscode.WebviewPanel {
  const existing = getMostRecentPanel();
  if (existing) {
    existing.reveal();
    return existing;
  }
  return createCrispyPanel(context, vscode.ViewColumn.One);
}

/**
 * Open a Crispy panel with smart 3-way logic:
 * - No panels exist → create new panel in current editor column
 * - Panel exists but not focused → reveal + focus input
 * - Panel is focused → create new panel beside it
 *
 * @param context  VS Code extension context (for webview resource URIs)
 */
export function openCrispyPanel(context: vscode.ExtensionContext): void {
  const column = vscode.window.activeTextEditor?.viewColumn;

  // If panel(s) exist but none is focused → reveal the most recent one
  const existing = getMostRecentPanel();
  if (existing && !isAnyPanelActive()) {
    existing.reveal(column);
    existing.webview.postMessage({ kind: 'focusInput' });
    return;
  }

  // No panels, or a panel is focused → create new panel
  // If a panel is focused, open beside it; otherwise use current column
  createCrispyPanel(
    context,
    isAnyPanelActive() ? vscode.ViewColumn.Beside : (column || vscode.ViewColumn.One),
  );
}

/**
 * Create and show a Crispy webview panel.
 *
 * @param context     VS Code extension context (for webview resource URIs)
 * @param viewColumn  Column to open the panel in (default: Beside for backward compat)
 */
export function createCrispyPanel(
  context: vscode.ExtensionContext,
  viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'crispy',
    'Crispy',
    viewColumn,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
      ],
    },
  );

  // Tab icon
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'crispy-icon.svg');

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
  const handler = createClientConnection(panelId, (msg) => {
    if (!disposed) {
      panel.webview.postMessage(msg);
    }
  });

  // Wire listener BEFORE setting HTML to prevent race condition.
  // The dev-server has no race because ws.on('message') is registered
  // synchronously inside the 'connection' callback before any data arrives.
  panel.webview.onDidReceiveMessage(
    async (msg) => {
      // VS Code-specific: open file in editor (requires vscode API,
      // so handled here rather than in shared message-handler)
      if (msg.kind === 'request' && msg.method === 'openFile') {
        const filePath = msg.params?.path as string;
        if (filePath) {
          const line = (msg.params?.line as number) ?? 1;
          const col = (msg.params?.col as number) ?? 1;
          await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
            viewColumn: vscode.ViewColumn.Beside,
            selection: new vscode.Range(
              new vscode.Position(line - 1, col - 1),
              new vscode.Position(line - 1, col - 1),
            ),
            preview: false,
          });
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

      // VS Code-specific: fork to new panel beside the current one
      if (msg.kind === 'request' && msg.method === 'forkToNewPanel') {
        const { fromSessionId, atMessageId, initialPrompt, model, agencyMode, bypassEnabled, chromeEnabled } = msg.params ?? {};

        // Create new panel beside the current one
        const newPanel = createCrispyPanel(context, vscode.ViewColumn.Beside);

        // Send fork config to the new panel after it initializes.
        // Retry a few times to handle slow webview startup — the listener
        // is idempotent (SET_FORK_MODE with same value is a no-op).
        const forkConfig = {
          kind: 'forkConfig',
          fromSessionId,
          atMessageId,
          initialPrompt,
          model,
          agencyMode,
          bypassEnabled,
          chromeEnabled,
        };
        const delays = [100, 500, 1500];
        for (const delay of delays) {
          setTimeout(() => newPanel.webview.postMessage(forkConfig), delay);
        }

        // Respond to source panel
        if (!disposed) {
          panel.webview.postMessage({
            kind: 'response',
            id: msg.id,
            result: { ok: true },
          } satisfies HostMessage);
        }
        return;
      }

      // VS Code-specific: pick file from candidates via QuickPick
      if (msg.kind === 'request' && msg.method === 'pickFile') {
        const candidates = (msg.params?.candidates as string[]) ?? [];
        const picked = candidates.length > 0
          ? (await vscode.window.showQuickPick(candidates, {
              placeHolder: 'Multiple files match — pick one to open',
            })) ?? null
          : null;
        if (!disposed) {
          panel.webview.postMessage({
            kind: 'response',
            id: msg.id,
            result: { picked },
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

  panels.set(panelId, panel);

  // Auto-focus chat input whenever the panel becomes active (user clicks tab,
  // switches back from editor, etc.). This complements the mount-time autofocus
  // in ChatInput and the explicit focusInput in openCrispyPanel's reveal path.
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) {
      panel.webview.postMessage({ kind: 'focusInput' });
    }
  });

  panel.onDidDispose(() => {
    disposed = true;
    handler.dispose();
    panels.delete(panelId);
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
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource};"
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
