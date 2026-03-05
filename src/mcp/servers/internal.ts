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
  server.tool(
    'search_sessions',
    'Full-text search over Crispy session activity. Searches Rosie-generated summaries, titles, quests, entities, and user prompts. Returns BM25-ranked results with match snippets.',
    {
      query: z.string().describe('Search query — supports natural language or FTS5 syntax (AND, OR, NOT, "quoted phrases", prefix*)'),
      limit: z.number().optional().default(20).describe('Maximum results to return (default 20)'),
      kind: z.enum(['prompt', 'rosie-meta']).optional().describe('Filter by entry kind'),
    },
    async (args) => {
      try {
        const results = searchSessions(dbPath, args.query, args.limit, args.kind);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ results, count: results.length }, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            results: [],
            error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // list_sessions — List distinct sessions with latest metadata
  // ------------------------------------------------------------------
  server.tool(
    'list_sessions',
    'List distinct Crispy sessions with their latest Rosie metadata (quest, title, status). Ordered by most recent activity.',
    {
      limit: z.number().optional().default(50).describe('Maximum sessions to return (default 50)'),
      since: z.string().optional().describe('ISO timestamp — only return sessions with activity after this time'),
    },
    async (args) => {
      const results = listSessions(dbPath, args.limit, args.since);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ sessions: results, count: results.length }, null, 2) }],
      };
    },
  );

  // ------------------------------------------------------------------
  // session_context — Full activity history for a specific session
  // ------------------------------------------------------------------
  server.tool(
    'session_context',
    'Get the full activity history for a specific session file. Returns all prompts and Rosie summaries in chronological order.',
    {
      file: z.string().describe('Session transcript file path (from search_sessions or list_sessions results)'),
      kind: z.enum(['prompt', 'rosie-meta']).optional().describe('Filter by entry kind'),
    },
    async (args) => {
      const results = sessionContext(dbPath, args.file, args.kind);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ entries: results, count: results.length }, null, 2) }],
      };
    },
  );

  return server;
}
