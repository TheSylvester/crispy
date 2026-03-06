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
import { join, extname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { initSettings, startWatchingSettings } from '../core/settings/index.js';
import { createClientConnection } from './client-connection.js';
import { createAgentDispatch } from './agent-dispatch.js';
import { startRescan } from '../core/session-list-manager.js';
import { registerAllAdapters } from './adapter-registry.js';
import { runScan } from '../core/activity-scanner.js';
import { initRosieSummarize, shutdownRosieSummarize } from '../core/rosie/index.js';

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

// Create dispatch first — needed by adapter-registry for recall agent
const cwd = process.cwd();
const dispatch = createAgentDispatch();

// Register all available adapters (passes dispatch for recall tool)
registerAllAdapters({ cwd, hostType: 'dev-server', dispatch });

// Wire up Rosie summarize hook
initRosieSummarize(dispatch);

// Initialize settings from ~/.config/crispy/settings.json
const providerBase = { cwd };
initSettings(providerBase).then(() => startWatchingSettings()).catch((err) => console.error('[dev-server] Failed to initialize settings:', err));

server.listen(PORT, () => {
  console.log(`[dev-server] Crispy dev server running at http://localhost:${PORT}`);
  console.log(`[dev-server] WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`[dev-server] Serving static files from: ${STATIC_DIR}`);
  console.log(`[dev-server] Adapters registered`);
  startRescan();

  // Activity scanning — deferred to avoid blocking server startup
  const safeRunScan = () => {
    try { runScan(); } catch (err) { console.error('[dev-server] Activity scan failed:', err); }
  };
  setImmediate(safeRunScan);
  setInterval(safeRunScan, 30_000);
});

// Crash guard — prevent unhandled MCP/SDK rejections from killing the process
process.on('unhandledRejection', (reason) => {
  console.error('[dev-server] Unhandled rejection:', reason);
});

// Cleanup on shutdown
process.on('SIGINT', () => {
  shutdownRosieSummarize();
  dispatch.dispose();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdownRosieSummarize();
  dispatch.dispose();
  process.exit(0);
});
