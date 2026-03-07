/**
 * Mock OpenCode HTTP server for adapter tests.
 *
 * Provides:
 * - GET /global/health → { ok: true }
 * - POST /session → create session response
 * - POST /session/:id/prompt_async → 204
 * - POST /session/:id/abort → 200
 * - POST /session/:id/permissions/:permissionID → 200
 * - GET /event → SSE stream with pushSSE() method
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface MockOpenCodeServer {
  port: number;
  baseUrl: string;
  pushSSE(event: Record<string, unknown>): void;
  close(): Promise<void>;
  /** Track POST requests for assertions. */
  readonly requests: Array<{ method: string; url: string; body: unknown }>;
}

export function createMockOpenCodeServer(): Promise<MockOpenCodeServer> {
  return new Promise((resolve, reject) => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let sseResponse: ServerResponse | null = null;

    const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '';
      const method = req.method ?? 'GET';

      // Collect body for POST requests
      let body: unknown;
      if (method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const raw = Buffer.concat(chunks).toString();
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        requests.push({ method, url, body });
      }

      // Health check
      if (url === '/global/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Create session
      if (method === 'POST' && url.startsWith('/session') && !url.includes('/prompt') && !url.includes('/abort') && !url.includes('/permissions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-session-1',
          projectID: 'proj-1',
          directory: '/tmp/test',
          title: 'Mock Session',
          version: '1.0.0',
          time: { created: Date.now() / 1000, updated: Date.now() / 1000 },
        }));
        return;
      }

      // Prompt async
      if (method === 'POST' && url.includes('/prompt_async')) {
        res.writeHead(204);
        res.end();
        return;
      }

      // Abort
      if (method === 'POST' && url.includes('/abort')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('true');
        return;
      }

      // Permission reply
      if (method === 'POST' && url.includes('/permissions/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('true');
        return;
      }

      // SSE event stream
      if (url.startsWith('/event')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        sseResponse = res;
        // Keep connection open
        req.on('close', () => {
          if (sseResponse === res) sseResponse = null;
        });
        return;
      }

      // 404 for anything else
      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }

      const port = addr.port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        pushSSE(event: Record<string, unknown>) {
          if (!sseResponse) return;
          const type = (event.type as string) ?? 'message';
          sseResponse.write(`event: ${type}\n`);
          sseResponse.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        close() {
          return new Promise<void>((res) => {
            sseResponse?.end();
            server.close(() => res());
          });
        },
      });
    });

    server.on('error', reject);
  });
}
