/**
 * Open Sessions Sidebar View — VS Code WebviewViewProvider
 *
 * Renders a small webview bundle (`dist/webview/sidebar.js`) in the Activity
 * Bar that lists live in-process Crispy session channels. Distinct from
 * editor-area panels: this is a persistent sidebar surfacing live channels
 * regardless of which panel is open. Uses its own minimal transport (see
 * `sidebar-transport.ts`) — adding the full `client-connection` RPC stack
 * would just bloat the bundle since the surface is `listOpenSessions` plus
 * a "something changed" stream.
 *
 * @module sessions-sidebar-view
 */

import * as vscode from 'vscode';
import { listOpenChannels } from '../core/session-manager.js';
import {
  subscribeSessionList,
  unsubscribeSessionList,
  type SessionListSubscriber,
} from '../core/session-list-manager.js';
import { getGitBranchInfoCached } from '../core/git-info-cache.js';
import { getNonce } from './webview-host.js';
import { openPanel } from './panel-opener.js';

let viewCounter = 0;

type RpcParams = Record<string, unknown> | undefined;
type RpcMethod = (params: RpcParams, ctx: { subscribe: () => void }) => unknown;

export class OpenSessionsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'crispy.openSessions';

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [distRoot],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    const subId = `sidebar-${++viewCounter}`;
    let listSub: SessionListSubscriber | null = null;
    let disposed = false;
    let pendingNotify = false;

    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const workspaceCwdMsg = { kind: 'workspaceCwd', cwd: workspaceCwd };
    webviewView.webview.postMessage(workspaceCwdMsg);
    const workspaceCwdRetry = setTimeout(() => {
      if (!disposed) webviewView.webview.postMessage(workspaceCwdMsg);
    }, 100);

    // Coalesce burst notifications (status changes during streaming, rescan
    // upserts) into one webview ping per microtask — sidebar refetches the
    // full list on each ping, so deduplication matters.
    function postSessionListChanged(): void {
      if (disposed || pendingNotify) return;
      pendingNotify = true;
      queueMicrotask(() => {
        pendingNotify = false;
        if (disposed) return;
        webviewView.webview.postMessage({ kind: 'sessionListChanged' });
      });
    }

    function ensureSubscribed(): void {
      if (listSub) return;
      listSub = { id: subId, send: postSessionListChanged };
      subscribeSessionList(listSub);
    }

    const methods: Record<string, RpcMethod> = {
      listOpenSessions: (params) => {
        const p = (params ?? {}) as { includeSystem?: boolean; includeSidechains?: boolean };
        return listOpenChannels({
          includeSystem: p.includeSystem,
          includeSidechains: p.includeSidechains,
        });
      },
      subscribeSessionList: (_params, ctx) => {
        ctx.subscribe();
        return { subscribed: true };
      },
      getGitBranchInfo: (params) => {
        const cwd = (params ?? {} as { cwd?: unknown }).cwd;
        if (typeof cwd !== 'string') throw new Error('getGitBranchInfo: cwd must be a string');
        return getGitBranchInfoCached(cwd);
      },
    };

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.kind === 'revealSession' && typeof msg.sessionId === 'string') {
        openPanel(msg.sessionId);
        return;
      }

      if (msg.kind !== 'request' || typeof msg.id !== 'string' || typeof msg.method !== 'string') {
        return;
      }

      const method = methods[msg.method];
      if (!method) {
        webviewView.webview.postMessage({
          kind: 'error',
          id: msg.id,
          error: `Unknown sidebar method: ${msg.method}`,
        });
        return;
      }

      // Async dispatch — methods may return Promises (e.g. getGitBranchInfo).
      // Sync results pass through unchanged because `await syncValue === syncValue`.
      void (async () => {
        try {
          const result = await method(msg.params as RpcParams, { subscribe: ensureSubscribed });
          if (disposed) return;
          webviewView.webview.postMessage({ kind: 'response', id: msg.id, result });
        } catch (err) {
          if (disposed) return;
          webviewView.webview.postMessage({
            kind: 'error',
            id: msg.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, undefined, this.context.subscriptions);

    webviewView.onDidDispose(() => {
      disposed = true;
      clearTimeout(workspaceCwdRetry);
      if (listSub) {
        unsubscribeSessionList(listSub);
        listSub = null;
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'sidebar.js'));
    // esbuild bundles JS-imported CSS into a sibling `sidebar.css`.
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'sidebar.css'));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Open Sessions</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
