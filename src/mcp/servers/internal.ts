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
import { searchSessions, listSessions, sessionContext, readTurnContent, getDbPath } from '../memory-queries.js';

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
    (query: string, limit: number, kind?: string, since?: string, before?: string) => searchSessions(dbPath, query, limit, kind, since, before),
  );

  server.tool(
    'search_sessions',
    'Full-text search over session activity. Returns BM25-ranked results with match snippets, summaries, and titles — often enough to answer without drilling deeper. Start here for most queries. Supports FTS5 syntax: use OR for broad searches ("sqlite OR database"), "quoted phrases" for exact matches, prefix* for partial terms. Supports time filtering with since/before.',
    {
      query: z.string().describe('Search query — use OR to broaden, "quoted phrases" for exact matches, prefix* for partial terms. Prefer short keywords over long natural-language phrases.'),
      limit: z.number().optional().default(20).describe('Maximum results to return (default 20)'),
      kind: z.enum(['prompt', 'rosie-meta']).optional().describe('Filter by entry kind: "rosie-meta" for AI-generated summaries (richer), "prompt" for raw user prompts'),
      since: z.string().optional().describe('ISO timestamp — only return results after this time (e.g. "2026-03-01T00:00:00Z")'),
      before: z.string().optional().describe('ISO timestamp — only return results before this time'),
    },
    async (args) => {
      console.error(`[internal-mcp] search_sessions: query="${args.query}" limit=${args.limit} kind=${args.kind ?? 'all'} since=${args.since ?? '-'} before=${args.before ?? '-'}`);
      return runSearch(args.query, args.limit, args.kind, args.since, args.before);
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
    'Browse sessions by recency — use when you need to scan recent work without a specific search term, or when search returns nothing and you want to browse what exists. Returns session titles, quests, and status.',
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
    'Get the activity index for a specific session — returns timestamped metadata entries (titles, quests, summaries, entities) in chronological order. This is structured metadata, NOT the raw conversation. Use read_turn to get actual conversation content.',
    {
      file: z.string().describe('Session transcript file path (from search_sessions or list_sessions results)'),
      kind: z.enum(['prompt', 'rosie-meta']).optional().describe('Filter by entry kind'),
    },
    async (args) => {
      console.error(`[internal-mcp] session_context: file="${args.file}" kind=${args.kind ?? 'all'}`);
      return runContext(args.file, args.kind);
    },
  );

  // ------------------------------------------------------------------
  // read_turn — Read full turn content from disk
  // ------------------------------------------------------------------
  server.tool(
    'read_turn',
    'Read the full user prompt and assistant response at a byte offset. This is the only way to see actual conversation content. Use the file path and byte offset from search_sessions or session_context results.',
    {
      file: z.string().describe('Session transcript file path (from search results)'),
      offset: z.number().describe('Byte offset of the turn (from the "id" field in search results or session_context entries)'),
    },
    async (args) => {
      console.error(`[internal-mcp] read_turn: file="${args.file}" offset=${args.offset}`);
      try {
        const result = readTurnContent(args.file, args.offset);
        if (!result) {
          console.error('[internal-mcp] read_turn: not found');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ turn: null, found: false }, null, 2) }],
            isError: true,
          };
        }
        console.error(`[internal-mcp] read_turn: OK (prompt=${result.userPrompt.length} chars, response=${result.assistantResponse?.length ?? 0} chars)`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ turn: result, found: true }, null, 2) }],
        };
      } catch (err) {
        console.error('[internal-mcp] read_turn FAIL:', err instanceof Error ? err.message : String(err));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            turn: null,
            found: false,
            error: `read_turn failed: ${err instanceof Error ? err.message : String(err)}`,
          }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  return server;
}
