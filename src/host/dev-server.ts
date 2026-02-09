/**
 * Dev Server — Chrome Mode
 *
 * Lightweight HTTP + WebSocket server for developing and testing the
 * Crispy UI in a real browser. Uses node:http + ws (no Express/Fastify).
 *
 * - Serves static files from dist/webview/
 * - WebSocket upgrade on /ws
 * - Auto-registers ClaudeAgentAdapter on startup
 *
 * Usage: npm run dev
 *
 * @module dev-server
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { registerAdapter } from '../core/session-manager.js';
import { ClaudeAgentAdapter, claudeDiscovery } from '../core/adapters/claude/claude-code-adapter.js';
import { createMessageHandler } from './message-handler.js';

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

const wss = new WebSocketServer({ server, path: '/ws' });

let connectionCounter = 0;

wss.on('connection', (ws: WebSocket) => {
  const clientId = `ws-client-${++connectionCounter}`;
  console.log(`[dev-server] Client connected: ${clientId}`);

  const handler = createMessageHandler(clientId, (msg) => {
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

// Register Claude discovery + adapter factory
const cwd = process.cwd();
registerAdapter(
  claudeDiscovery,
  (sessionId) => new ClaudeAgentAdapter({ cwd, resume: sessionId }),
);

server.listen(PORT, () => {
  console.log(`[dev-server] Crispy dev server running at http://localhost:${PORT}`);
  console.log(`[dev-server] WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`[dev-server] Serving static files from: ${STATIC_DIR}`);
  console.log(`[dev-server] Adapter registered for vendor: ${claudeDiscovery.vendor}`);
});
