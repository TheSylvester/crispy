/**
 * Entry point for the internal stdio MCP server process.
 *
 * Run: node --import tsx src/mcp/servers/internal-main.ts
 *
 * Instantiates the internal MCP server and connects it to stdio transport.
 * Separate from the server class so the server can be tested without stdio.
 *
 * @module mcp/servers/internal-main
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createInternalServer } from './internal.js';

process.on('unhandledRejection', (err) => {
  console.error('[internal-mcp] Unhandled rejection:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function main() {
  console.error('[internal-mcp] Starting stdio server...');
  const server = createInternalServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[internal-mcp] Connected — ready for tool calls');
}

main().catch((err) => {
  console.error('[internal-mcp] Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
