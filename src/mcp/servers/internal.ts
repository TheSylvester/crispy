/**
 * Internal stdio MCP Server — raw tools for internal agents.
 *
 * Exposes search_sessions, list_sessions, and session_context as MCP tools
 * over stdio. Designed to be spawned as a child process by the recall agent
 * or any vendor's child agents that need session memory access.
 *
 * Uses @modelcontextprotocol/sdk (vendor-agnostic) — not the Claude SDK.
 * This is the extensible knowledge backend — future graph search, commit
 * provenance, and file tracing tools land here.
 *
 * @module mcp/servers/internal
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { searchSessions, listSessions, sessionContext, getDbPath } from '../memory-queries.js';

// ============================================================================
// Helpers
// ============================================================================

type McpToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

/** Wrap an MCP tool handler with consistent error handling and JSON serialization. */
function wrapToolHandler<T extends unknown[]>(
  toolName: string,
  resultKey: string,
  queryFn: (...args: T) => unknown[],
): (...args: T) => McpToolResult {
  return (...args: T): McpToolResult => {
    try {
      const results = queryFn(...args);
      console.error(`[internal-mcp] ${toolName}: ${results.length} ${resultKey}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ [resultKey]: results, count: results.length }, null, 2) }],
      };
    } catch (err) {
      console.error(`[internal-mcp] ${toolName} FAIL:`, err instanceof Error ? err.message : String(err));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          [resultKey]: [],
          error: `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
        }, null, 2) }],
        isError: true,
      };
    }
  };
}

// ============================================================================
// Server Factory
// ============================================================================

/**
 * Create the internal MCP server instance.
 *
 * Returns the McpServer — callers connect their own transport (stdio for
 * production, in-memory for tests).
 */
export function createInternalServer(): McpServer {
  const server = new McpServer({
    name: 'crispy-memory',
    version: '1.0.0',
  });

  const dbPath = getDbPath();

  // ------------------------------------------------------------------
  // search_sessions — FTS5 search over activity entries
  // ------------------------------------------------------------------
  const runSearch = wrapToolHandler('search_sessions', 'results',
    (query: string, limit: number, kind?: string) => searchSessions(dbPath, query, limit, kind),
  );

  server.tool(
    'search_sessions',
    'Full-text search over Crispy session activity. Searches Rosie-generated summaries, titles, quests, entities, and user prompts. Returns BM25-ranked results with match snippets.',
    {
      query: z.string().describe('Search query — supports natural language or FTS5 syntax (AND, OR, NOT, "quoted phrases", prefix*)'),
      limit: z.number().optional().default(20).describe('Maximum results to return (default 20)'),
      kind: z.enum(['prompt', 'rosie-meta']).optional().describe('Filter by entry kind'),
    },
    async (args) => {
      console.error(`[internal-mcp] search_sessions: query="${args.query}" limit=${args.limit} kind=${args.kind ?? 'all'}`);
      return runSearch(args.query, args.limit, args.kind);
    },
  );

  // ------------------------------------------------------------------
  // list_sessions — List distinct sessions with latest metadata
  // ------------------------------------------------------------------
  const runList = wrapToolHandler('list_sessions', 'sessions',
    (limit: number, since?: string) => listSessions(dbPath, limit, since),
  );

  server.tool(
    'list_sessions',
    'List distinct Crispy sessions with their latest Rosie metadata (quest, title, status). Ordered by most recent activity.',
    {
      limit: z.number().optional().default(50).describe('Maximum sessions to return (default 50)'),
      since: z.string().optional().describe('ISO timestamp — only return sessions with activity after this time'),
    },
    async (args) => {
      console.error(`[internal-mcp] list_sessions: limit=${args.limit} since=${args.since ?? 'all'}`);
      return runList(args.limit, args.since);
    },
  );

  // ------------------------------------------------------------------
  // session_context — Full activity history for a specific session
  // ------------------------------------------------------------------
  const runContext = wrapToolHandler('session_context', 'entries',
    (file: string, kind?: string) => sessionContext(dbPath, file, kind),
  );

  server.tool(
    'session_context',
    'Get the full activity history for a specific session file. Returns all prompts and Rosie summaries in chronological order.',
    {
      file: z.string().describe('Session transcript file path (from search_sessions or list_sessions results)'),
      kind: z.enum(['prompt', 'rosie-meta']).optional().describe('Filter by entry kind'),
    },
    async (args) => {
      console.error(`[internal-mcp] session_context: file="${args.file}" kind=${args.kind ?? 'all'}`);
      return runContext(args.file, args.kind);
    },
  );

  return server;
}
