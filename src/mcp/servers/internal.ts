/**
 * Internal stdio MCP Server — raw tools for internal agents.
 *
 * Exposes search/browse tools for the recall agent and project tracking
 * tools for the tracker agent, all over stdio. Designed to be spawned as
 * a child process by any vendor's child agents that need session memory
 * access. Each consumer sees only its tools via allowedTools glob patterns.
 *
 * Uses @modelcontextprotocol/sdk (vendor-agnostic) — not the Claude SDK.
 * This is the extensible knowledge backend — future graph search, commit
 * provenance, and file tracing tools land here.
 *
 * @module mcp/servers/internal
 */

import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { searchSessions, listSessions, sessionContext, readTurnContent, getDbPath, searchTranscript, readMessageTurn } from '../memory-queries.js';

import { writeTrackerResults, recordTrackerOutcome } from '../../core/rosie/tracker/db-writer.js';
import { VALID_STATUSES } from '../../core/rosie/tracker/types.js';
import type { TrackerBlock } from '../../core/rosie/tracker/types.js';

// ============================================================================
// Constants
// ============================================================================

/** Canonical server name — referenced by MCP config builders and allowedTools patterns. */
export const INTERNAL_MCP_SERVER_NAME = 'crispy-memory';

// ============================================================================
// Helpers
// ============================================================================

type McpToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

/** Decision record appended to the sidecar file for parent-process observability. */
export interface TrackerDecision {
  tool: 'upsert_project' | 'mark_trivial';
  action?: 'created' | 'updated';
  title?: string;
  status?: string;
  reason?: string;
}

/**
 * Options for configuring the internal MCP server.
 *
 * These values are passed as CLI args (--session-file, --decisions-file)
 * rather than env vars, so they work regardless of how the host adapter
 * spawns MCP subprocesses. Falls back to env vars for backwards compatibility.
 */
export interface InternalServerOptions {
  /** Session file path for tracker's upsert_project tool. */
  sessionFile?: string;
  /** Sidecar JSONL file for tracker decision observability. */
  decisionsFile?: string;
  /** Project path for scoping search_transcript results. */
  projectId?: string;
}

/** Module-level options — set by createInternalServer(), read by tool handlers. */
let serverOptions: InternalServerOptions = {};

/**
 * Append a decision record to the sidecar file.
 * The parent process reads this after dispatchChild completes and pushes entries
 * to the rosie debug log. Silently no-ops if no decisions file is configured.
 */
function appendDecision(decision: TrackerDecision): void {
  const file = serverOptions.decisionsFile ?? process.env.CRISPY_TRACKER_DECISIONS_FILE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify(decision) + '\n');
  } catch {
    // Best-effort — don't break the tool handler if the file can't be written
  }
}

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
 *
 * @param options - CLI-provided options (session file, decisions file).
 *   Falls back to env vars for backwards compatibility.
 */
export function createInternalServer(options?: InternalServerOptions): McpServer {
  serverOptions = options ?? {};
  const server = new McpServer({
    name: INTERNAL_MCP_SERVER_NAME,
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

  // ------------------------------------------------------------------
  // upsert_project — Create or update a tracked project
  // ------------------------------------------------------------------
  // Only available when CRISPY_TRACKER_SESSION_FILE is set (tracker child
  // sessions). The env var provides the session file path for DB writes.
  // ------------------------------------------------------------------
  server.tool(
    'upsert_project',
    'Create a new project or update an existing one based on this session\'s work. Call this once per project this session touches. For existing projects, provide the id from the project list. For new projects, omit the id or leave it empty.',
    {
      id: z.string().optional().describe('UUID of an existing project to update. Must match an id from the existing projects list. Leave empty or omit to create a new project.'),
      title: z.string().describe('Short, stable project title. Keep consistent across sessions — don\'t rename unless scope fundamentally changed.'),
      status: z.enum(VALID_STATUSES).describe('Current project status.'),
      summary: z.string().describe('1-2 sentence summary of current project state. Reflect what\'s true RIGHT NOW, not history.'),
      blocked_by: z.string().optional().describe('Why it\'s blocked (only if status is \'blocked\', otherwise omit).'),
      branch: z.string().optional().describe('Git branch name if applicable, otherwise omit.'),
      entities: z.array(z.string()).describe('Top 5-10 key entities: file paths, branch names, function names, concepts. Used for matching future sessions to this project.'),
      files: z.array(z.object({
        path: z.string().describe('File path to a non-code artifact.'),
        note: z.string().describe('Why this file is relevant.'),
      })).optional().describe('Non-code artifacts only: plans, specs, design docs. NOT source code — source files belong in entities. Omit if none.'),
    },
    async (args) => {
      const sessionFile = serverOptions.sessionFile ?? process.env.CRISPY_TRACKER_SESSION_FILE;
      if (!sessionFile) {
        console.error('[internal-mcp] upsert_project: session file not configured (no --session-file arg or CRISPY_TRACKER_SESSION_FILE env)');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: 'Session file not configured — this tool is only available in tracker child sessions' }) }],
          isError: true,
        };
      }

      const block: TrackerBlock = {
        project: {
          action: 'upsert',
          id: args.id ?? '',
          title: args.title,
          status: args.status,
          blocked_by: args.blocked_by ?? '',
          summary: args.summary,
          branch: args.branch ?? '',
          entities: JSON.stringify(args.entities),
        },
        sessionRef: { detected_in: '' },
        files: (args.files ?? []).map((f) => ({ path: f.path, note: f.note })),
      };

      try {
        writeTrackerResults([block], sessionFile);
        const action = args.id ? 'updated' : 'created';
        console.error(`[internal-mcp] upsert_project: ${action} "${args.title}" (${args.status})`);
        appendDecision({ tool: 'upsert_project', action, title: args.title, status: args.status });
        // Persist tracked outcome to DB
        recordTrackerOutcome(sessionFile, 'tracked', 1, args.title);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', action, project: args.title }) }],
        };
      } catch (err) {
        console.error('[internal-mcp] upsert_project FAIL:', err instanceof Error ? err.message : String(err));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: `upsert_project failed: ${err instanceof Error ? err.message : String(err)}` }) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // mark_trivial — Flag session as not warranting project tracking
  // ------------------------------------------------------------------
  server.tool(
    'mark_trivial',
    'Mark this session as trivial — no project needed. Use when the session was a quick recall, empty session, false start, or doesn\'t represent meaningful project work.',
    {
      reason: z.string().describe('Brief reason why no project is warranted.'),
    },
    async (args) => {
      console.error(`[internal-mcp] mark_trivial: "${args.reason}"`);
      appendDecision({ tool: 'mark_trivial', reason: args.reason });
      // Persist trivial outcome to DB
      const sessionFile = process.env.CRISPY_TRACKER_SESSION_FILE;
      if (sessionFile) {
        recordTrackerOutcome(sessionFile, 'trivial', 1, args.reason);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', trivial: true, reason: args.reason }) }],
      };
    },
  );

  // ------------------------------------------------------------------
  // search_transcript — FTS5 search over raw conversation content
  // ------------------------------------------------------------------
  server.tool(
    'search_transcript',
    'Full-text search over raw conversation content from past sessions. Returns matching messages with session ID, message UUID, and text snippet. Project-scoped by default — searches only sessions from the current workspace. Supports FTS5 syntax: OR for broad searches, "quoted phrases" for exact matches, prefix* for partial terms.',
    {
      query: z.string().describe('Search query — short keywords work best. Use OR to broaden: "sqlite OR database"'),
      limit: z.number().optional().default(20).describe('Maximum results (default 20)'),
      all_projects: z.boolean().optional().default(false).describe('Search across all projects instead of just the current workspace'),
    },
    async (args) => {
      const projectId = args.all_projects ? undefined : serverOptions.projectId;
      console.error(`[internal-mcp] search_transcript: query="${args.query}" limit=${args.limit} project=${projectId ?? 'all'}`);
      try {
        const results = searchTranscript(args.query, args.limit, projectId);
        console.error(`[internal-mcp] search_transcript: ${results.length} results`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ results, count: results.length }, null, 2) }],
        };
      } catch (err) {
        console.error(`[internal-mcp] search_transcript FAIL:`, err instanceof Error ? err.message : String(err));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            results: [],
            error: `search_transcript failed: ${err instanceof Error ? err.message : String(err)}`,
          }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // read_message — Read a full conversation turn by message UUID
  // ------------------------------------------------------------------
  server.tool(
    'read_message',
    'Read a full conversation turn (user prompt + assistant response) by message UUID. Returns the stripped text without tool calls. Use the message_id and session_id from search_transcript results.',
    {
      session_id: z.string().describe('Session ID from search results'),
      message_id: z.string().describe('Message UUID from search results'),
    },
    async (args) => {
      console.error(`[internal-mcp] read_message: session=${args.session_id} message=${args.message_id}`);
      try {
        const result = readMessageTurn(args.session_id, args.message_id);
        if (!result) {
          console.error('[internal-mcp] read_message: not found');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ turn: null, found: false }, null, 2) }],
            isError: true,
          };
        }
        console.error(`[internal-mcp] read_message: OK (user=${result.userText.length} chars, assistant=${result.assistantText.length} chars)`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ turn: result, found: true }, null, 2) }],
        };
      } catch (err) {
        console.error('[internal-mcp] read_message FAIL:', err instanceof Error ? err.message : String(err));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            turn: null,
            found: false,
            error: `read_message failed: ${err instanceof Error ? err.message : String(err)}`,
          }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  return server;
}
