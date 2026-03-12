/**
 * Dev Server — Chrome Mode
 *
 * Lightweight HTTP + WebSocket server for developing and testing the
 * Crispy UI in a real browser. Uses node:http + ws (no Express/Fastify).
 *
 * - Serves static files from dist/webview/
 * - WebSocket upgrade on /ws
 * - Auto-registers all available vendor adapters on startup
 *
 * Usage: npm run dev
 *
 * @module dev-server
 */

// Unblock nested Claude sessions — dev server is often launched from inside
// Claude Code which sets CLAUDECODE=1, blocking child Claude processes.
delete process.env.CLAUDECODE;

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { initSettings, startWatchingSettings } from '../core/settings/index.js';
import { createClientConnection } from './client-connection.js';
import { createAgentDispatch } from './agent-dispatch.js';
import { startRescan } from '../core/session-list-manager.js';
import { registerAllAdapters } from './adapter-registry.js';
import { initRosieSummarize, shutdownRosieSummarize, initRosieTracker, shutdownRosieTracker } from '../core/rosie/index.js';
import { initRecallIngest, shutdownRecallIngest } from '../core/recall/ingest-hook.js';
import { startRecallCatchup, stopEmbeddingBackfill } from '../core/recall/catchup-manager.js';
import { initEmbedWorker, shutdownEmbedWorker } from '../core/recall/embedder.js';
import { resolveInternalServerPaths } from './adapter-registry.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);

// Resolve webview static dir relative to this file's location.
// When bundled by esbuild to dist/dev-server.js, the webview files
// are at dist/webview/. When running via tsx, we resolve from cwd.
const STATIC_DIR = join(process.cwd(), 'dist', 'webview');

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
// HTTP Server — Static Files
// ============================================================================

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
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

// ============================================================================
// WebSocket Server
// ============================================================================

const wss = new WebSocketServer({ noServer: true });

// ---------------------------------------------------------------------------
// Origin validation — reject WebSocket upgrades from non-localhost Origins.
// Blocks CSWSH (cross-site WebSocket hijacking) where a malicious webpage
// connects to ws://localhost:3456/ws from the user's browser.
// Same vulnerability class as CVE-2025-52882 / GHSA-w48q-cv73-mx4w.
// ---------------------------------------------------------------------------

function isLocalhostOrigin(origin: string): boolean {
  if (!origin) return true; // no Origin header → non-browser client (CLI, curl)
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const origin = req.headers.origin ?? '';
  if (!isLocalhostOrigin(origin)) {
    console.warn(`[dev-server] Rejected WebSocket upgrade from origin: ${origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

let connectionCounter = 0;

wss.on('connection', (ws: WebSocket) => {
  const clientId = `ws-client-${++connectionCounter}`;
  console.log(`[dev-server] Client connected: ${clientId}`);

  const handler = createClientConnection(clientId, (msg) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });

  ws.on('message', (data) => {
    handler.handleMessage(String(data)).catch((err) => {
      console.error(`[dev-server] Handler error:`, err);
    });
  });

  ws.on('close', () => {
    console.log(`[dev-server] Client disconnected: ${clientId}`);
    handler.dispose();
  });

  ws.on('error', (err) => {
    console.error(`[dev-server] WebSocket error (${clientId}):`, err);
    handler.dispose();
  });
});

// ============================================================================
// Startup
// ============================================================================

function phase(name: string): () => void {
  const t0 = performance.now();
  console.log(`[dev-server] ▸ ${name}...`);
  return () => console.log(`[dev-server] ✓ ${name} (${(performance.now() - t0).toFixed(0)}ms)`);
}

const bootStart = performance.now();

let done: () => void;

done = phase('create agent dispatch');
const cwd = process.cwd();
const dispatch = createAgentDispatch();
done();

done = phase('register adapters');
registerAllAdapters({ cwd, hostType: 'dev-server', dispatch });
done();

done = phase('init recall ingest');
initRecallIngest();
initEmbedWorker(resolve(process.cwd(), 'src', 'core', 'recall', 'embed-worker.ts'), true);
startRecallCatchup('devServer');
done();

done = phase('init rosie summarize');
initRosieSummarize(dispatch);
done();

done = phase('init rosie tracker');
initRosieTracker(dispatch, resolveInternalServerPaths());
done();

const settingsDone = phase('init settings');
const providerBase = { cwd };
initSettings(providerBase)
  .then(() => {
    startWatchingSettings();
    settingsDone();
  })
  .catch((err) => {
    console.error('[dev-server] ✗ init settings failed:', err);
  });

const listenDone = phase('listen');
server.listen(PORT, () => {
  listenDone();

  console.log(`[dev-server] ──────────────────────────────────────`);
  console.log(`[dev-server] HTTP:      http://localhost:${PORT}`);
  console.log(`[dev-server] WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`[dev-server] Static:    ${STATIC_DIR}`);
  console.log(`[dev-server] ──────────────────────────────────────`);

  startRescan();

  console.log(`[dev-server] ★ ready — accepting connections (${(performance.now() - bootStart).toFixed(0)}ms)`);
});

// Crash guard — prevent unhandled MCP/SDK rejections from killing the process
process.on('unhandledRejection', (reason) => {
  console.error('[dev-server] Unhandled rejection:', reason);
});

// Cleanup on shutdown
process.on('SIGINT', () => {
  shutdownRosieTracker();
  shutdownRosieSummarize();
  shutdownRecallIngest();
  stopEmbeddingBackfill();
  shutdownEmbedWorker();
  dispatch.dispose();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdownRosieTracker();
  shutdownRosieSummarize();
  shutdownRecallIngest();
  stopEmbeddingBackfill();
  shutdownEmbedWorker();
  dispatch.dispose();
  process.exit(0);
});
