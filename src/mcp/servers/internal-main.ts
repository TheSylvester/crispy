/**
 * Entry point for the internal stdio MCP server process.
 *
 * This file serves BOTH runtime modes:
 *
 * - Dev server: run directly via `tsx src/mcp/servers/internal-main.ts`
 * - VS Code extension: pre-bundled to `dist/internal-mcp.js` by the
 *   `build:internal-mcp` script, then spawned via `node dist/internal-mcp.js`
 *
 * The bundled version inlines node-sqlite3-wasm's JS and resolves
 * the .wasm binary via __dirname (copied to dist/ by build:extension).
 *
 * Path resolution for spawning this process lives in adapter-registry.ts
 * (registerAllAdapters). It uses extensionPath for VS Code, process.cwd()
 * for dev server. If recall stops working, check there first.
 *
 * @module mcp/servers/internal-main
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createInternalServer, type InternalServerOptions } from './internal.js';
import { log } from '../../core/log.js';
import { ensureBinary, ensureModel } from '../../core/recall/embedder.js';

process.on('unhandledRejection', (err) => {
  const msg = `Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`;
  process.stderr.write(msg + '\n');
  log({ level: 'error', source: 'internal-mcp', summary: msg, data: { error: err instanceof Error ? err.message : String(err) } });
  process.exit(1);
});

/**
 * Parse --key=value CLI args into an options object.
 */
function parseCliArgs(): InternalServerOptions {
  const opts: InternalServerOptions = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--project-id=')) opts.projectId = arg.slice('--project-id='.length);
    else if (arg.startsWith('--deadline-ms=')) opts.deadlineMs = parseInt(arg.slice('--deadline-ms='.length), 10) || undefined;
    else if (arg.startsWith('--exclude-session-id=')) opts.excludeSessionId = arg.slice('--exclude-session-id='.length);
  }
  return opts;
}

async function main() {
  const cliOpts = parseCliArgs();
  const startMsg = `Starting stdio server`;
  process.stderr.write(startMsg + '\n');
  log({ level: 'info', source: 'internal-mcp', summary: startMsg });

  // Pre-warm embedder: ensure binary + model are downloaded and ready before
  // the first search_transcript call. This runs concurrently with MCP transport
  // setup so there's no added latency. If warmup fails, embed() will fail
  // later and dualPathSearch will fall back to FTS5-only (now with visibility).
  const warmupPromise = Promise.all([ensureBinary(), ensureModel()])
    .then(() => log({ level: 'info', source: 'internal-mcp', summary: 'Embedder warmup complete — semantic search ready' }))
    .catch((err) => log({ level: 'warn', source: 'internal-mcp', summary: `Embedder warmup failed — semantic search will be unavailable: ${err instanceof Error ? err.message : String(err)}` }));

  const server = createInternalServer(cliOpts);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Warmup proceeds in background. Don't block server ready — if warmup is slow
  // or fails, dualPathSearch will use FTS5-only (logged in warmupPromise catch handler).
  warmupPromise.finally(() => {
    log({ level: 'info', source: 'internal-mcp', summary: 'Embedder warmup finished' });
  });

  log({ level: 'info', source: 'internal-mcp', summary: 'Connected — ready for tool calls' });
}

main().catch((err) => {
  const msg = `Fatal: ${err instanceof Error ? err.message : String(err)}`;
  process.stderr.write(msg + '\n');
  log({ level: 'error', source: 'internal-mcp', summary: msg, data: { error: err instanceof Error ? err.message : String(err) } });
  process.exit(1);
});
