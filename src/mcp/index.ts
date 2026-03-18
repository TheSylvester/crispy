/**
 * MCP Module — MCP servers for session memory.
 *
 * - external: In-process MCP server with `recall` tool (user-facing)
 * - internal: Stdio MCP server with raw search tools (for internal agents)
 * - memory-queries: Pure query functions shared by both servers
 *
 * @module mcp
 */

export { createExternalServer } from './servers/external.js';
export { createInternalServer } from './servers/internal.js';
export { listSessions, getDbPath } from './memory-queries.js';
