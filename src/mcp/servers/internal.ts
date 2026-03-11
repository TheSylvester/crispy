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
import { searchSessions, listSessions, sessionContext, readTurnContent, getDbPath, searchTranscript, searchTranscriptMeta, readMessageTurn, grepMessages, readSessionMessages } from '../memory-queries.js';
import { pushEventLog } from '../../core/rosie/event-log.js';

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
  /** Wall-clock deadline (epoch ms) after which tool calls are refused. */
  deadlineMs?: number;
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

// ============================================================================
// Time-awareness helpers
// ============================================================================

/**
 * Build a time warning footer if we're in the warning window (last 30s before deadline).
 * Returns null if no deadline configured or if we're still in the clean search phase.
 *
 * Timeline (for 180s total timeout, deadline at 120s):
 *   0-90s   -> no footer (clean search phase)
 *   90-120s -> warning footer ("Xs of search time remaining")
 *   120s+   -> handled by caller (tool call refused entirely)
 */
function buildTimeFooter(): { type: 'text'; text: string } | null {
  if (!serverOptions.deadlineMs) return null;
  const remainingMs = serverOptions.deadlineMs - Date.now();
  const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
  if (remaining <= 30) {
    return { type: 'text' as const, text: `[TIME WARNING] ${remaining}s of search time remaining. Wrap up your search and synthesize your answer.` };
  }
  return null;
}

/** Return an error result when the deadline has expired. */
function buildTimeExpiredResult(): McpToolResult {
  return {
    content: [{ type: 'text' as const, text: 'TIME\'S UP. Do not call any more tools. Respond immediately with your answer based on what you have found so far.' }],
    isError: true,
  };
}

/**
 * Append time footer to an MCP tool result.
 * If deadline has passed, replaces the result entirely with an expired error.
 * If no deadline configured, returns result unchanged.
 */
function withTimeFooter(result: McpToolResult): McpToolResult {
  if (!serverOptions.deadlineMs) return result;
  if (Date.now() >= serverOptions.deadlineMs) return buildTimeExpiredResult();
  const footer = buildTimeFooter();
  if (footer) {
    return { ...result, content: [...result.content, footer] };
  }
  return result;
}

/** Wrap an MCP tool handler with consistent error handling and JSON serialization. */
function wrapToolHandler<T extends unknown[]>(
  toolName: string,
  resultKey: string,
  queryFn: (...args: T) => unknown[],
): (...args: T) => McpToolResult {
  return (...args: T): McpToolResult => {
    const t0 = Date.now();
    try {
      const results = queryFn(...args);
      const elapsed = Date.now() - t0;
      console.error(`[internal-mcp] ${toolName}: ${results.length} ${resultKey}`);
      pushEventLog({
        source: `recall:${toolName}`,
        summary: `${results.length} ${resultKey} in ${elapsed}ms`,
        data: {
          args,
          resultCount: results.length,
          elapsed,
          hits: (results as Array<Record<string, unknown>>).slice(0, 10).map((r) => ({
            ...(r.file ? { file: r.file } : {}),
            ...(r.title ? { title: (r.title as string).slice(0, 80) } : {}),
            ...(r.quest ? { quest: (r.quest as string).slice(0, 80) } : {}),
          })),
        },
      }, getDbPath());
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ [resultKey]: results, count: results.length }, null, 2) }],
      };
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.error(`[internal-mcp] ${toolName} FAIL:`, err instanceof Error ? err.message : String(err));
      pushEventLog({
        source: `recall:${toolName}`,
        level: 'error',
        summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
        data: { args, elapsed, error: String(err) },
      }, getDbPath());
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

/**
 * Register a tool with deadline awareness.
 * Checks deadline before running the handler; appends time footer after.
 * Use for recall/search tools only — tracker tools use server.tool() directly.
 */
function timedTool(
  srv: McpServer,
  name: string,
  description: string,
  schema: Record<string, z.ZodType>,
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>,
): void {
  srv.tool(name, description, schema, async (args) => {
    if (serverOptions.deadlineMs && Date.now() >= serverOptions.deadlineMs) {
      return buildTimeExpiredResult();
    }
    const result = await handler(args as Record<string, unknown>);
    return withTimeFooter(result);
  });
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

  timedTool(server,
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
      return runSearch(args.query as string, args.limit as number, args.kind as string | undefined, args.since as string | undefined, args.before as string | undefined);
    },
  );

  // ------------------------------------------------------------------
  // list_sessions — List distinct sessions with latest metadata
  // ------------------------------------------------------------------
  const runList = wrapToolHandler('list_sessions', 'sessions',
    (limit: number, since?: string) => listSessions(dbPath, limit, since),
  );

  timedTool(server,
    'list_sessions',
    'Browse sessions by recency — use when you need to scan recent work without a specific search term, or when search returns nothing and you want to browse what exists. Returns session titles, quests, and status.',
    {
      limit: z.number().optional().default(50).describe('Maximum sessions to return (default 50)'),
      since: z.string().optional().describe('ISO timestamp — only return sessions with activity after this time'),
    },
    async (args) => {
      console.error(`[internal-mcp] list_sessions: limit=${args.limit} since=${args.since ?? 'all'}`);
      return runList(args.limit as number, args.since as string | undefined);
    },
  );

  // ------------------------------------------------------------------
  // session_context — Full activity history for a specific session
  // ------------------------------------------------------------------
  const runContext = wrapToolHandler('session_context', 'entries',
    (file: string, kind?: string) => sessionContext(dbPath, file, kind),
  );

  timedTool(server,
    'session_context',
    'Get the activity index for a specific session — returns timestamped metadata entries (titles, quests, summaries, entities) in chronological order. This is structured metadata, NOT the raw conversation. Use read_turn to get actual conversation content.',
    {
      file: z.string().describe('Session transcript file path (from search_sessions or list_sessions results)'),
      kind: z.enum(['prompt', 'rosie-meta']).optional().describe('Filter by entry kind'),
    },
    async (args) => {
      console.error(`[internal-mcp] session_context: file="${args.file}" kind=${args.kind ?? 'all'}`);
      return runContext(args.file as string, args.kind as string | undefined);
    },
  );

  // ------------------------------------------------------------------
  // read_turn — Read full turn content from disk
  // ------------------------------------------------------------------
  timedTool(server,
    'read_turn',
    'Read the full user prompt and assistant response at a byte offset. This is the only way to see actual conversation content. Use the file path and byte offset from search_sessions or session_context results.',
    {
      file: z.string().describe('Session transcript file path (from search results)'),
      offset: z.number().describe('Byte offset of the turn (from the "id" field in search results or session_context entries)'),
    },
    async (args) => {
      const file = args.file as string;
      const offset = args.offset as number;
      console.error(`[internal-mcp] read_turn: file="${file}" offset=${offset}`);
      const t0 = Date.now();
      try {
        const result = readTurnContent(file, offset);
        const elapsed = Date.now() - t0;
        if (!result) {
          console.error('[internal-mcp] read_turn: not found');
          pushEventLog({
            source: 'recall:read_turn',
            level: 'warn',
            summary: `not found in ${elapsed}ms`,
            data: { file, offset, elapsed },
          }, getDbPath());
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ turn: null, found: false }, null, 2) }],
            isError: true,
          };
        }
        const promptChars = result.userPrompt.length;
        const responseChars = result.assistantResponse?.length ?? 0;
        console.error(`[internal-mcp] read_turn: OK (prompt=${promptChars} chars, response=${responseChars} chars)`);
        pushEventLog({
          source: 'recall:read_turn',
          summary: `OK in ${elapsed}ms — prompt=${promptChars} chars, response=${responseChars} chars`,
          data: { file, offset, elapsed, promptChars, responseChars },
        }, getDbPath());
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ turn: result, found: true }, null, 2) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        console.error('[internal-mcp] read_turn FAIL:', err instanceof Error ? err.message : String(err));
        pushEventLog({
          source: 'recall:read_turn',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { file, offset, elapsed, error: String(err) },
        }, getDbPath());
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
  timedTool(server,
    'search_transcript',
    'Full-text search over raw conversation content from past sessions. Returns matching messages with session ID, message UUID, highlighted snippet, and a short preview (up to 200 chars). Also returns total_matches and session_hits (per-session hit counts) so you can see how many sessions discuss a topic. Project-scoped by default. Supports FTS5 syntax: OR for broad searches, "quoted phrases" for exact matches, prefix* for partial terms. Use read_message to get the full conversation turn. Use session_id to search within a specific session.',
    {
      query: z.string().describe('Search query — short keywords work best. Use OR to broaden: "sqlite OR database"'),
      limit: z.number().optional().default(20).describe('Maximum results (default 20)'),
      session_id: z.string().optional().describe('Scope search to a single session (use after broad search to drill into a specific session)'),
      all_projects: z.boolean().optional().default(false).describe('Search across all projects instead of just the current workspace'),
    },
    async (args) => {
      const query = args.query as string;
      const limit = args.limit as number;
      const projectId = args.all_projects ? undefined : serverOptions.projectId;
      const sessionId = args.session_id as string | undefined;
      console.error(`[internal-mcp] search_transcript: query="${query}" limit=${limit} project=${projectId ?? 'all'} session=${sessionId ?? 'all'}`);
      const t0 = Date.now();
      try {
        const results = searchTranscript(query, limit, projectId, sessionId);
        const meta = searchTranscriptMeta(query, projectId, sessionId);
        const elapsed = Date.now() - t0;
        console.error(`[internal-mcp] search_transcript: ${results.length} of ${meta.total_matches} results (${Object.keys(meta.session_hits).length} sessions)`);
        pushEventLog({
          source: 'recall:search_transcript',
          summary: `${results.length} of ${meta.total_matches} results in ${elapsed}ms`,
          data: {
            query, limit, projectId, sessionId,
            resultCount: results.length, totalMatches: meta.total_matches,
            sessionCount: Object.keys(meta.session_hits).length, elapsed,
            hits: results.slice(0, 10).map((r) => ({
              sessionId: r.session_id,
              snippet: r.match_snippet?.slice(0, 100),
            })),
          },
        }, getDbPath());
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            results,
            count: results.length,
            total_matches: meta.total_matches,
            session_hits: meta.session_hits,
          }, null, 2) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        console.error(`[internal-mcp] search_transcript FAIL:`, err instanceof Error ? err.message : String(err));
        pushEventLog({
          source: 'recall:search_transcript',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { query, limit, projectId, sessionId, elapsed, error: String(err) },
        }, getDbPath());
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
  timedTool(server,
    'read_message',
    'Read a full conversation turn (user prompt + assistant response) by message UUID. Returns the stripped text without tool calls. Use context > 0 to see surrounding messages (like reading a window of a file). Response includes session_total_messages and showing_seq_range so you know how much of the session you\'ve seen.',
    {
      session_id: z.string().describe('Session ID from search results'),
      message_id: z.string().describe('Message UUID from search results'),
      context: z.number().optional().default(0).describe('Number of extra turns to include on each side (0-5). Use 2-3 to see surrounding conversation flow.'),
    },
    async (args) => {
      const sessionId = args.session_id as string;
      const messageId = args.message_id as string;
      const ctx = (args.context as number | undefined) ?? 0;
      console.error(`[internal-mcp] read_message: session=${sessionId} message=${messageId} context=${ctx}`);
      const t0 = Date.now();
      try {
        const result = readMessageTurn(sessionId, messageId, ctx);
        const elapsed = Date.now() - t0;
        if (!result) {
          console.error('[internal-mcp] read_message: not found');
          pushEventLog({
            source: 'recall:read_message',
            level: 'warn',
            summary: `not found in ${elapsed}ms`,
            data: { sessionId, messageId, context: ctx, elapsed },
          }, getDbPath());
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ turn: null, found: false }, null, 2) }],
            isError: true,
          };
        }
        const userChars = result.userText.length;
        const assistantChars = result.assistantText.length;
        const ctxCount = result.context_messages?.length ?? 0;
        console.error(`[internal-mcp] read_message: OK (user=${userChars} chars, assistant=${assistantChars} chars, context=${ctxCount} msgs)`);
        pushEventLog({
          source: 'recall:read_message',
          summary: `OK in ${elapsed}ms — user=${userChars} chars, assistant=${assistantChars} chars, context=${ctxCount}`,
          data: { sessionId, messageId, context: ctx, elapsed, userChars, assistantChars, ctxCount },
        }, getDbPath());
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ turn: result, found: true }, null, 2) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        console.error('[internal-mcp] read_message FAIL:', err instanceof Error ? err.message : String(err));
        pushEventLog({
          source: 'recall:read_message',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { sessionId, messageId, context: ctx, elapsed, error: String(err) },
        }, getDbPath());
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

  // ------------------------------------------------------------------
  // grep — Regex search over clean message text
  // ------------------------------------------------------------------
  timedTool(server,
    'grep',
    'Regex search over conversation text (tool calls already stripped). Use when FTS5 keyword search misses — grep finds substrings, patterns, and partial matches that FTS5 tokenization can\'t. Scope to a session_id for fast targeted search, or omit to scan recent messages across sessions. Returns matching text with surrounding context.',
    {
      pattern: z.string().describe('Regex pattern (case-insensitive). Use simple substrings like "intermediary" or patterns like "ToolSearch.*bypass". Invalid regex is treated as literal text.'),
      session_id: z.string().optional().describe('Scope to a single session (fast). Omit to scan across recent sessions.'),
      limit: z.number().optional().default(20).describe('Maximum matches to return (default 20)'),
      all_projects: z.boolean().optional().default(false).describe('Search across all projects instead of just the current workspace'),
    },
    async (args) => {
      const pattern = args.pattern as string;
      const limit = args.limit as number;
      const sessionId = args.session_id as string | undefined;
      const projectId = args.all_projects ? undefined : serverOptions.projectId;
      console.error(`[internal-mcp] grep: pattern="${pattern}" session=${sessionId ?? 'all'} limit=${limit}`);
      const t0 = Date.now();
      try {
        const results = grepMessages(pattern, limit, sessionId, projectId);
        const elapsed = Date.now() - t0;
        const sessionCount = new Set(results.map(r => r.session_id)).size;
        console.error(`[internal-mcp] grep: ${results.length} matches across ${sessionCount} sessions in ${elapsed}ms`);
        pushEventLog({
          source: 'recall:grep',
          summary: `${results.length} matches in ${elapsed}ms`,
          data: { pattern, sessionId, limit, resultCount: results.length, sessionCount, elapsed },
        }, getDbPath());
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            matches: results,
            count: results.length,
            sessions: sessionCount,
          }, null, 2) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        console.error(`[internal-mcp] grep FAIL:`, err instanceof Error ? err.message : String(err));
        pushEventLog({
          source: 'recall:grep',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { pattern, elapsed, error: String(err) },
        }, getDbPath());
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ matches: [], error: String(err) }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // read_session — Sequential session reader with pagination
  // ------------------------------------------------------------------
  timedTool(server,
    'read_session',
    'Read messages from a session sequentially, like reading a file with offset/limit. Returns clean conversation text (tool calls stripped) with pagination: "showing 0-9 of 47, has_more: true". Use to browse a session\'s conversation flow, or continue reading from where you left off.',
    {
      session_id: z.string().describe('Session ID to read'),
      offset: z.number().optional().default(0).describe('Start from this message index (0-based). Use the value from a previous response to continue reading.'),
      limit: z.number().optional().default(10).describe('Number of messages to return (default 10, max 20)'),
    },
    async (args) => {
      const sessionId = args.session_id as string;
      const offset = (args.offset as number | undefined) ?? 0;
      const limit = Math.min((args.limit as number | undefined) ?? 10, 20);
      console.error(`[internal-mcp] read_session: session=${sessionId} offset=${offset} limit=${limit}`);
      const t0 = Date.now();
      try {
        const page = readSessionMessages(sessionId, offset, limit);
        const elapsed = Date.now() - t0;
        if (!page) {
          console.error('[internal-mcp] read_session: session not found or empty');
          pushEventLog({
            source: 'recall:read_session',
            level: 'warn',
            summary: `not found in ${elapsed}ms`,
            data: { sessionId, offset, limit, elapsed },
          }, getDbPath());
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ session: null, found: false }, null, 2) }],
            isError: true,
          };
        }
        console.error(`[internal-mcp] read_session: OK (${page.showing_count} of ${page.total_messages} messages, has_more=${page.has_more})`);
        pushEventLog({
          source: 'recall:read_session',
          summary: `OK in ${elapsed}ms — ${page.showing_count} of ${page.total_messages} msgs`,
          data: { sessionId, offset, limit, elapsed, total: page.total_messages, returned: page.showing_count },
        }, getDbPath());
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ session: page, found: true }, null, 2) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        console.error('[internal-mcp] read_session FAIL:', err instanceof Error ? err.message : String(err));
        pushEventLog({
          source: 'recall:read_session',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { sessionId, offset, limit, elapsed, error: String(err) },
        }, getDbPath());
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ session: null, found: false, error: String(err) }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  return server;
}
