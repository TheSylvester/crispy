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
import { createInternalServer } from './internal.js';
import { log } from '../../core/log.js';

process.on('unhandledRejection', (err) => {
  const msg = `Unhandled rejection: ${err instanceof Error ? err.message : String(err)}`;
  process.stderr.write(msg + '\n');
  log({ level: 'error', source: 'internal-mcp', summary: msg, data: { error: err instanceof Error ? err.message : String(err) } });
  process.exit(1);
});

/**
 * Parse --key=value CLI args into an options object.
 * Supports: --session-file, --decisions-file
 */
function parseCliArgs(): { sessionFile?: string; decisionsFile?: string; projectId?: string; deadlineMs?: number; excludeSessionId?: string } {
  const opts: { sessionFile?: string; decisionsFile?: string; projectId?: string; deadlineMs?: number; excludeSessionId?: string } = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--session-file=')) opts.sessionFile = arg.slice('--session-file='.length);
    else if (arg.startsWith('--decisions-file=')) opts.decisionsFile = arg.slice('--decisions-file='.length);
    else if (arg.startsWith('--project-id=')) opts.projectId = arg.slice('--project-id='.length);
    else if (arg.startsWith('--deadline-ms=')) opts.deadlineMs = parseInt(arg.slice('--deadline-ms='.length), 10) || undefined;
    else if (arg.startsWith('--exclude-session-id=')) opts.excludeSessionId = arg.slice('--exclude-session-id='.length);
  }
  return opts;
}

async function main() {
  const cliOpts = parseCliArgs();
  const startMsg = `Starting stdio server${cliOpts.sessionFile ? ` session=${cliOpts.sessionFile}` : ''}`;
  process.stderr.write(startMsg + '\n');
  log({ level: 'info', source: 'internal-mcp', summary: startMsg });
  const server = createInternalServer(cliOpts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log({ level: 'info', source: 'internal-mcp', summary: 'Connected — ready for tool calls' });
}

main().catch((err) => {
  const msg = `Fatal: ${err instanceof Error ? err.message : String(err)}`;
  process.stderr.write(msg + '\n');
  log({ level: 'error', source: 'internal-mcp', summary: msg, data: { error: err instanceof Error ? err.message : String(err) } });
  process.exit(1);
});
