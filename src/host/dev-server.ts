/**
 * Dev Server / Standalone Daemon
 *
 * Serves the Crispy UI over HTTP + WebSocket. Two modes:
 *
 * - **dev** (`npm run dev`): runs from repo root via tsx, resolves assets
 *   from `dist/webview/` relative to cwd. Self-run block at the bottom.
 * - **daemon** (`crispy` CLI): runs from global install, resolves assets
 *   relative to the compiled bundle location (`__dirname`).
 *
 * Both modes share the same startup sequence — only path resolution and
 * IPC socket strategy differ.
 *
 * @module dev-server
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { initSettings, startWatchingSettings } from '../core/settings/index.js';
import { createClientConnection } from './client-connection.js';
import { createAgentDispatch } from './agent-dispatch.js';
import { startRescan } from '../core/session-list-manager.js';
import { registerAllAdapters } from './adapter-registry.js';
import { initRosieBot, shutdownRosieBot } from '../core/rosie/index.js';
import { initRecallIngest, shutdownRecallIngest } from '../core/recall/ingest-hook.js';
import { startRecallCatchup, stopEmbeddingBackfill } from '../core/recall/catchup-manager.js';
import { disposeEmbedder } from '../core/recall/embedder.js';
import { startIpcServer, getSocketPath } from './ipc-server.js';
import { setHostSocketPath } from '../core/session-manager.js';
import { isLocalConnection, validateToken, parseCookie, cookieName, setTokenCookie, getOrCreateToken } from './auth.js';

// __dirname is available in CJS (tsx, tsc). When esbuild bundles to ESM with
// --platform=node it shims __dirname automatically, so this works in both modes.

// ============================================================================
// Types
// ============================================================================

export interface ServerConfig {
  port: number;
  host: string;             // '127.0.0.1' or '0.0.0.0'
  mode: 'dev' | 'daemon';
  hostType: 'dev-server' | 'daemon';
  logFile?: string;         // when set, redirect console to this file
}

export interface ServerHandle {
  port: number;             // actual port (may differ if conflict)
  shutdown(): Promise<void>;
}

// ============================================================================
// MIME Types
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ============================================================================
// Helpers
// ============================================================================

function isLocalhostOrigin(origin: string): boolean {
  if (!origin) return true; // no Origin header → non-browser client (CLI, curl)
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function phase(name: string): () => void {
  const t0 = performance.now();
  console.log(`[server] ▸ ${name}...`);
  return () => console.log(`[server] ✓ ${name} (${(performance.now() - t0).toFixed(0)}ms)`);
}

// ============================================================================
// startServer
// ============================================================================

export async function startServer(config: ServerConfig): Promise<ServerHandle> {
  const { port, host, mode, hostType, logFile } = config;

  // Log file redirect (for daemon mode)
  if (logFile) {
    const { createWriteStream } = await import('node:fs');
    const stream = createWriteStream(logFile, { flags: 'a' });
    const write = stream.write.bind(stream);
    console.log = (...args: unknown[]) => { write(args.map(String).join(' ') + '\n'); };
    console.warn = (...args: unknown[]) => { write('[warn] ' + args.map(String).join(' ') + '\n'); };
    console.error = (...args: unknown[]) => { write('[error] ' + args.map(String).join(' ') + '\n'); };
  }

  const bootStart = performance.now();

  // Static dir: resolve relative to this file, not cwd.
  // dev mode: tsx runs from repo root, assets at dist/webview/ under cwd.
  // daemon mode: __dirname is dist/, assets at dist/webview/.
  const STATIC_DIR = mode === 'dev'
    ? join(process.cwd(), 'dist', 'webview')
    : join(__dirname, 'webview');

  // Port may be bumped on EADDRINUSE — declare with let so handlers see the
  // final value via closure.
  let actualPort = port;

  // Initialize auth token on daemon startup
  if (mode === 'daemon') {
    getOrCreateToken();
  }

  // ---- HTTP Server ----
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${actualPort}`);

    // Health endpoint (unauthenticated — used by CLI status checks)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid, port: actualPort, uptime: process.uptime() }));
      return;
    }

    // Token exchange: GET /?token=xyz → set cookie, redirect to /
    const tokenParam = url.searchParams.get('token');
    if (tokenParam) {
      if (validateToken(tokenParam)) {
        res.writeHead(302, {
          'Location': '/',
          'Set-Cookie': setTokenCookie(actualPort, tokenParam),
        });
        res.end();
      } else {
        res.writeHead(401);
        res.end('Invalid token');
      }
      return;
    }

    // Auth check (skip for localhost — zero friction for local use)
    if (!isLocalConnection(req)) {
      const cookie = parseCookie(req.headers.cookie, cookieName(actualPort));
      if (!cookie || !validateToken(cookie)) {
        res.writeHead(401, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; max-width: 400px; margin: 100px auto;">
            <h2>Crispy</h2>
            <p>Enter your access token:</p>
            <form method="GET" action="/">
              <input name="token" type="password" autofocus style="width: 100%; padding: 8px; font-size: 16px;">
              <button type="submit" style="margin-top: 8px; padding: 8px 16px;">Connect</button>
            </form>
            <p style="color: #666; font-size: 12px;">Find your token in ~/.crispy/token</p>
          </body></html>
        `);
        return;
      }
    }

    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

    // Prevent directory traversal
    if (filePath.includes('..')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const fullPath = join(STATIC_DIR, filePath);
    const ext = extname(fullPath);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    try {
      const content = await readFile(fullPath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  // ---- WebSocket Server ----
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', `http://localhost:${actualPort}`);
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin ?? '';
    if (!isLocalhostOrigin(origin)) {
      // Non-localhost origin: require valid cookie auth
      const cookie = parseCookie(req.headers.cookie, cookieName(actualPort));
      if (!cookie || !validateToken(cookie)) {
        console.warn(`[server] Rejected WebSocket upgrade: invalid auth from origin ${origin}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  let connectionCounter = 0;

  wss.on('connection', (ws: WebSocket) => {
    const clientId = `ws-client-${++connectionCounter}`;
    console.log(`[server] Client connected: ${clientId}`);

    const handler = createClientConnection(clientId, (msg) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });

    ws.on('message', (data) => {
      handler.handleMessage(String(data)).catch((err) => {
        console.error(`[server] Handler error:`, err);
      });
    });

    ws.on('close', () => {
      console.log(`[server] Client disconnected: ${clientId}`);
      handler.dispose();
    });

    ws.on('error', (err) => {
      console.error(`[server] WebSocket error (${clientId}):`, err);
      handler.dispose();
    });
  });

  // ---- Startup sequence ----
  let done: () => void;

  done = phase('create agent dispatch');
  const cwd = process.cwd();
  const dispatch = createAgentDispatch();
  done();

  // For daemon mode, resolve extensionPath from __dirname (which is dist/ when bundled).
  // join(__dirname, '..') gives the package root.
  const extensionPath = mode === 'dev' ? undefined : join(__dirname, '..');

  done = phase('register adapters');
  registerAllAdapters({ cwd, hostType, dispatch, extensionPath });
  done();

  // IPC socket: use stable paths for daemon, PID-based for dev
  const socketMode = mode === 'daemon' ? 'prod' as const : undefined;
  setHostSocketPath(getSocketPath(socketMode));

  done = phase('init recall ingest');
  initRecallIngest();
  startRecallCatchup('devServer');
  done();

  done = phase('init rosie bot');
  // Tracker script: in dev mode it's under src/, in daemon mode it's bundled to dist/
  const trackerScript = mode === 'dev'
    ? join(process.cwd(), 'src', 'core', 'rosie', 'tracker', 'crispy-tracker.mjs')
    : join(__dirname, 'crispy-tracker.mjs');
  initRosieBot(dispatch, {
    trackerScript,
    ipcSocket: getSocketPath(socketMode),
  });
  done();

  const settingsDone = phase('init settings');
  const providerBase = { cwd };
  initSettings(providerBase)
    .then(() => {
      startWatchingSettings();
      settingsDone();
    })
    .catch((err) => {
      console.error('[server] init settings failed:', err);
    });

  // ---- Listen with port retry ----
  await new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const tryListen = () => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempts < 10) {
          attempts++;
          actualPort++;
          tryListen();
        } else {
          reject(err);
        }
      });
      server.listen(actualPort, host, () => {
        resolve();
      });
    };
    tryListen();
  });

  console.log(`[server] ──────────────────────────────────────`);
  console.log(`[server] HTTP:      http://${host}:${actualPort}`);
  console.log(`[server] WebSocket: ws://${host}:${actualPort}/ws`);
  console.log(`[server] Static:    ${STATIC_DIR}`);
  console.log(`[server] Mode:      ${mode}`);
  console.log(`[server] ──────────────────────────────────────`);

  startRescan();

  // Start IPC server
  let ipcHandle: { close(): void } | null = null;
  startIpcServer(cwd)
    .then((h) => { ipcHandle = h; })
    .catch((err) => console.error('[server] IPC server failed:', err));

  // Crash guard — prevent unhandled MCP/SDK rejections from killing the process
  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled rejection:', reason);
  });

  console.log(`[server] ★ ready (${(performance.now() - bootStart).toFixed(0)}ms)`);

  // ---- Shutdown ----
  async function shutdown(): Promise<void> {
    // 1. Notify connected WebSocket clients
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(JSON.stringify({ kind: 'event', event: { type: 'shutdown' } }));
        client.close(1001, 'Server shutting down');
      }
    }
    // 2. Close WebSocket server
    await new Promise<void>(resolve => wss.close(() => resolve()));
    // 3. Close HTTP server
    await new Promise<void>(resolve => server.close(() => resolve()));
    // 4. Existing cleanup
    ipcHandle?.close();
    shutdownRosieBot();
    shutdownRecallIngest();
    stopEmbeddingBackfill();
    disposeEmbedder();
    dispatch.dispose();
  }

  // Wire SIGINT/SIGTERM to shutdown
  const signalHandler = () => {
    shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  return { port: actualPort, shutdown };
}

// ============================================================================
// Self-run block — keeps `npm run dev` working
// ============================================================================

const isSelfRun = process.argv[1] &&
  (process.argv[1].endsWith('dev-server.ts') || process.argv[1].endsWith('dev-server.js'));

if (isSelfRun) {
  // Unblock nested Claude sessions — dev server is often launched from inside
  // Claude Code which sets CLAUDECODE=1, blocking child Claude processes.
  delete process.env.CLAUDECODE;

  startServer({
    port: parseInt(process.env.PORT ?? '3456', 10),
    host: '127.0.0.1',
    mode: 'dev',
    hostType: 'dev-server',
  }).catch(err => {
    console.error('[dev-server] Fatal:', err);
    process.exit(1);
  });
}
