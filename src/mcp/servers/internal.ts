/**
 * Internal stdio MCP Server — raw tools for internal agents.
 *
 * Exposes search/browse tools for the recall agent over stdio. Designed to
 * be spawned as a child process by any vendor's child agents that need
 * session memory access.
 *
 * Uses @modelcontextprotocol/sdk (vendor-agnostic) — not the Claude SDK.
 * This is the extensible knowledge backend — future graph search, commit
 * provenance, and file tracing tools land here.
 *
 * @module mcp/servers/internal
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { listSessions, readTurnContent, getDbPath, searchTranscript, searchTranscriptMeta, readMessageTurn, grepMessages, readSessionMessages } from '../memory-queries.js';
import { getDb } from '../../core/crispy-db.js';
import type { MessageSearchResult, DualPathSearchResult } from '../memory-queries.js';
import { log } from '../../core/log.js';


// ============================================================================
// Constants
// ============================================================================

/** Canonical server name — referenced by MCP config builders and allowedTools patterns. */
export const INTERNAL_MCP_SERVER_NAME = 'crispy-memory';

// ============================================================================
// Helpers
// ============================================================================

type McpToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };


/**
 * Options for configuring the internal MCP server.
 *
 * These values are passed as CLI args (--session-file, --decisions-file)
 * rather than env vars, so they work regardless of how the host adapter
 * spawns MCP subprocesses. Falls back to env vars for backwards compatibility.
 */
export interface InternalServerOptions {
  /** Project path for scoping search_transcript results. */
  projectId?: string;
  /** Wall-clock deadline (epoch ms) after which tool calls are refused. */
  deadlineMs?: number;
  /** Session ID to exclude from search results (caller's own session). */
  excludeSessionId?: string;
}

/** Module-level options — set by createInternalServer(), read by tool handlers. */
let serverOptions: InternalServerOptions = {};

function isExcludedSession(sessionId: string): boolean {
  return !!serverOptions.excludeSessionId && sessionId === serverOptions.excludeSessionId;
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
      log({
        source: `recall:${toolName}`,
        level: 'info',
        summary: `${results.length} ${resultKey} in ${elapsed}ms`,
        data: {
          args,
          resultCount: results.length,
          elapsed,
          hits: (results as Array<Record<string, unknown>>).slice(0, 10).map((r) => ({
            ...(r.file ? { file: r.file } : {}),
            ...(r.preview ? { preview: (r.preview as string).slice(0, 80) } : {}),
          })),
        },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ [resultKey]: results, count: results.length }) }],
      };
    } catch (err) {
      const elapsed = Date.now() - t0;
      log({
        source: `recall:${toolName}`,
        level: 'error',
        summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
        data: { args, elapsed, error: String(err) },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          [resultKey]: [],
          error: `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
        }) }],
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
// Timestamp Formatting
// ============================================================================

/** Format a Unix-ms timestamp as ISO date string for LLM consumption. */
function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

// ============================================================================
// Session Grouping
// ============================================================================

interface GroupedResult {
  /** Session UUID — use with read_session / select_sessions to drill down. */
  session_id: string;
  /** ISO 8601 date of the best-matching message. */
  date: string;
  /** Best-matching snippet (keyword-highlighted). */
  snippet: string;
  /** Total matching messages in this session. */
  hits: number;
}

/**
 * Group search results by session_id with score-gap detection.
 *
 * Aggregates RRF scores per session (sum of all matching messages), sorts by
 * total session score, then looks for the largest relative score drop to find
 * a natural relevance cliff. Returns all sessions above the cliff instead of
 * applying a hard numeric limit.
 *
 * This prevents high-volume "noise" sessions (e.g., sessions that discuss
 * testing recall) from pushing genuinely relevant sessions below a fixed cutoff.
 */
function groupBySession(searchResult: DualPathSearchResult): GroupedResult[] {
  // Aggregate RRF scores by session
  const sessionScores = new Map<string, {
    primary: MessageSearchResult;
    totalScore: number;
    hits: number;
  }>();

  for (const scored of searchResult.scored) {
    const sid = scored.result.session_id;
    const existing = sessionScores.get(sid);
    if (existing) {
      existing.totalScore += scored.score;
      existing.hits++;
    } else {
      sessionScores.set(sid, {
        primary: scored.result,
        totalScore: scored.score,
        hits: 1,
      });
    }
  }

  // Sort by total session score (descending)
  const sorted = [...sessionScores.values()];
  sorted.sort((a, b) => b.totalScore - a.totalScore);

  // Score gap detection: find where scores drop off a cliff
  let cutoff = sorted.length;
  if (sorted.length > 5) {
    let maxGap = 0;
    let gapIdx = sorted.length;
    // Search from position 5 onward for the biggest relative drop
    for (let i = 5; i < sorted.length; i++) {
      const prev = sorted[i - 1]!.totalScore;
      const curr = sorted[i]!.totalScore;
      if (prev > 0) {
        const relGap = (prev - curr) / prev;
        if (relGap > maxGap) {
          maxGap = relGap;
          gapIdx = i;
        }
      }
    }
    // Use gap if significant (>20% relative drop), otherwise take all
    if (maxGap > 0.20) {
      cutoff = gapIdx;
      log({ source: 'recall:score-gap', level: 'info',
        summary: `Gap ${(maxGap * 100).toFixed(0)}% at #${gapIdx}: ${sorted[gapIdx - 1]?.primary.session_id.slice(0, 8)}(${sorted[gapIdx - 1]?.totalScore.toFixed(4)}) → ${sorted[gapIdx]?.primary.session_id.slice(0, 8)}(${sorted[gapIdx]?.totalScore.toFixed(4)}). Returning ${cutoff} of ${sorted.length} sessions` });
    }
  }

  // Log session score distribution for diagnostics
  const distLog = sorted.slice(0, Math.min(60, sorted.length)).map((s, i) =>
    `${i}:${s.primary.session_id.slice(0, 8)}=${s.totalScore.toFixed(4)}(${s.hits})`
  ).join(' ');
  log({ source: 'recall:score-gap', level: 'debug', summary: `Session scores: ${distLog}` });

  return sorted.slice(0, cutoff).map(s => ({
    session_id: s.primary.session_id,
    date: formatTimestamp(s.primary.created_at),
    snippet: (s.primary.match_snippet ?? s.primary.message_preview ?? '').slice(0, 150),
    hits: s.hits,
  }));
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
 * @param options - CLI-provided options (project scope, deadline, exclusions).
 */
export function createInternalServer(options?: InternalServerOptions): McpServer {
  serverOptions = options ?? {};
  const server = new McpServer({
    name: INTERNAL_MCP_SERVER_NAME,
    version: '1.0.0',
  });

  const dbPath = getDbPath();

  // ------------------------------------------------------------------
  // list_sessions — List distinct sessions with latest metadata
  // ------------------------------------------------------------------
  const runList = wrapToolHandler('list_sessions', 'sessions',
    (limit: number, since?: string) => listSessions(dbPath, limit, since, serverOptions.excludeSessionId),
  );

  timedTool(server,
    'list_sessions',
    'Browse sessions by recency. Returns session_id, title, message_count, first_activity and last_activity (epoch ms), sorted by most recent activity. Use when you need to scan recent work without a specific search term, or when search returns nothing and you want to browse what exists.',
    {
      limit: z.number().optional().default(50).describe('Maximum sessions to return (default 50)'),
      since: z.string().optional().describe('ISO timestamp — only return sessions with activity after this time'),
    },
    async (args) => {
      log({ level: 'debug', source: 'recall:list_sessions', summary: `limit=${args.limit} since=${args.since ?? 'all'}` });
      return runList(args.limit as number, args.since as string | undefined);
    },
  );

  // ------------------------------------------------------------------
  // read_turn — Read full turn content from disk
  // ------------------------------------------------------------------
  timedTool(server,
    'read_turn',
    'Read the full user prompt and assistant response at a byte offset in a JSONL transcript file. Prefer read_message (by message UUID) over this tool — it is more reliable. Only use read_turn when you have a known byte offset.',
    {
      file: z.string().describe('Session transcript file path'),
      offset: z.number().describe('Byte offset of the turn in the JSONL file'),
    },
    async (args) => {
      const file = args.file as string;
      const offset = args.offset as number;
      log({ level: 'debug', source: 'recall:read_turn', summary: `file="${file}" offset=${offset}` });
      const t0 = Date.now();
      try {
        const result = readTurnContent(file, offset);
        const elapsed = Date.now() - t0;
        if (!result) {
          log({
            source: 'recall:read_turn',
            level: 'warn',
            summary: `not found in ${elapsed}ms`,
            data: { file, offset, elapsed },
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ turn: null, found: false }) }],
            isError: true,
          };
        }
        const promptChars = result.userPrompt.length;
        const responseChars = result.assistantResponse?.length ?? 0;
        log({
          source: 'recall:read_turn',
          level: 'info',
          summary: `OK in ${elapsed}ms — prompt=${promptChars} chars, response=${responseChars} chars`,
          data: { file, offset, elapsed, promptChars, responseChars },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ turn: result, found: true }) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        log({
          source: 'recall:read_turn',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { file, offset, elapsed, error: String(err) },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            turn: null,
            found: false,
            error: `read_turn failed: ${err instanceof Error ? err.message : String(err)}`,
          }) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // search_transcript — FTS5 search over raw conversation content
  // ------------------------------------------------------------------
  timedTool(server,
    'search_transcript',
    'Dual-path search (FTS5 keywords + semantic embeddings) over conversation content. Results grouped by session: session_id, date, snippet (150-char highlighted match), hits. Project-scoped by default. FTS5 syntax: OR to broaden, "quoted phrases" for exact, prefix* for partial.',
    {
      query: z.string().describe('Search query — short keywords work best. Use OR to broaden: "sqlite OR database"'),
      session_id: z.string().optional().describe('Scope search to a single session (use after broad search to drill into a specific session)'),
      all_projects: z.boolean().optional().default(false).describe('Search across all projects instead of just the current workspace'),
    },
    async (args) => {
      const query = args.query as string;
      const limit = 200; // generous ceiling — score gap in groupBySession cuts naturally
      const projectId = args.all_projects ? undefined : serverOptions.projectId;
      const sessionId = args.session_id as string | undefined;
      log({ level: 'debug', source: 'recall:search_transcript', summary: `query="${query}" limit=${limit} project=${projectId ?? 'all'} session=${sessionId ?? 'all'}` });
      const t0 = Date.now();
      try {
        const searchResult = await searchTranscript(query, limit, projectId, sessionId, serverOptions.excludeSessionId);
        const meta = searchTranscriptMeta(query, projectId, sessionId, serverOptions.excludeSessionId);
        const elapsed = Date.now() - t0;
        log({
          source: 'recall:search_transcript',
          level: searchResult.semanticAvailable ? 'info' : 'warn',
          summary: `${searchResult.results.length} of ${meta.total_matches} results in ${elapsed}ms (FTS5: ${searchResult.ftsCount}, Semantic: ${searchResult.semanticCount}${!searchResult.semanticAvailable ? ' UNAVAILABLE' : ''})`,
          data: {
            query, limit, projectId, sessionId,
            resultCount: searchResult.results.length, totalMatches: meta.total_matches,
            sessionCount: Object.keys(meta.session_hits).length, elapsed,
            semanticAvailable: searchResult.semanticAvailable,
            ftsCount: searchResult.ftsCount, semanticCount: searchResult.semanticCount,
            hits: searchResult.results.slice(0, 10).map((r) => ({
              sessionId: r.session_id,
              snippet: r.match_snippet?.slice(0, 100),
            })),
          },
        });
        // Group results by session — each session appears once with all its
        // unique snippets, so the agent sees more diverse sessions.
        const grouped = groupBySession(searchResult);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            results: grouped,
            count: grouped.length,
            total_matches: meta.total_matches,
            sessions_matched: Object.keys(meta.session_hits).length,
            search_paths: { fts5: searchResult.ftsCount, semantic: searchResult.semanticCount },
            semantic_available: searchResult.semanticAvailable,
          }) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        log({
          source: 'recall:search_transcript',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { query, limit, projectId, sessionId, elapsed, error: String(err) },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            results: [],
            error: `search_transcript failed: ${err instanceof Error ? err.message : String(err)}`,
          }) }],
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
      log({ level: 'debug', source: 'recall:read_message', summary: `session=${sessionId} message=${messageId} context=${ctx}` });
      const t0 = Date.now();
      try {
        if (isExcludedSession(sessionId)) {
          const elapsed = Date.now() - t0;
          log({
            source: 'recall:read_message',
            level: 'warn',
            summary: `blocked self-session read in ${elapsed}ms`,
            data: { sessionId, messageId, context: ctx, elapsed },
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              turn: null,
              found: false,
              error: 'read_message blocked: requested session is excluded from this recall context',
            }) }],
            isError: true,
          };
        }
        const result = readMessageTurn(sessionId, messageId, ctx);
        const elapsed = Date.now() - t0;
        if (!result) {
          log({
            source: 'recall:read_message',
            level: 'warn',
            summary: `not found in ${elapsed}ms`,
            data: { sessionId, messageId, context: ctx, elapsed },
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ turn: null, found: false }) }],
            isError: true,
          };
        }
        const userChars = result.userText.length;
        const assistantChars = result.assistantText.length;
        const ctxCount = result.context_messages?.length ?? 0;
        log({
          source: 'recall:read_message',
          level: 'info',
          summary: `OK in ${elapsed}ms — user=${userChars} chars, assistant=${assistantChars} chars, context=${ctxCount}`,
          data: { sessionId, messageId, context: ctx, elapsed, userChars, assistantChars, ctxCount },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ turn: result, found: true }) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        log({
          source: 'recall:read_message',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { sessionId, messageId, context: ctx, elapsed, error: String(err) },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            turn: null,
            found: false,
            error: `read_message failed: ${err instanceof Error ? err.message : String(err)}`,
          }) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // grep — Regex search over clean message text
  // Disabled: recall agent over-relies on grep for discovery instead of FTS5.
  // Re-enable if needed for exact-pattern verification after FTS5 discovery.
  // ------------------------------------------------------------------
  /* timedTool(server,
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
      log({ level: 'debug', source: 'recall:grep', summary: `pattern="${pattern}" session=${sessionId ?? 'all'} limit=${limit}` });
      const t0 = Date.now();
      try {
        const results = grepMessages(pattern, limit, sessionId, projectId, serverOptions.excludeSessionId);
        const elapsed = Date.now() - t0;
        const sessionCount = new Set(results.map(r => r.session_id)).size;
        log({
          source: 'recall:grep',
          level: 'info',
          summary: `${results.length} matches in ${elapsed}ms`,
          data: { pattern, sessionId, limit, resultCount: results.length, sessionCount, elapsed },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            matches: results,
            count: results.length,
            sessions: sessionCount,
          }) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        log({
          source: 'recall:grep',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { pattern, elapsed, error: String(err) },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ matches: [], error: String(err) }) }],
          isError: true,
        };
      }
    },
  ); */

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
      log({ level: 'debug', source: 'recall:read_session', summary: `session=${sessionId} offset=${offset} limit=${limit}` });
      const t0 = Date.now();
      try {
        if (isExcludedSession(sessionId)) {
          const elapsed = Date.now() - t0;
          log({
            source: 'recall:read_session',
            level: 'warn',
            summary: `blocked self-session read in ${elapsed}ms`,
            data: { sessionId, offset, limit, elapsed },
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              session: null,
              found: false,
              error: 'read_session blocked: requested session is excluded from this recall context',
            }) }],
            isError: true,
          };
        }
        const page = readSessionMessages(sessionId, offset, limit);
        const elapsed = Date.now() - t0;
        if (!page) {
          log({
            source: 'recall:read_session',
            level: 'warn',
            summary: `not found in ${elapsed}ms`,
            data: { sessionId, offset, limit, elapsed },
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ session: null, found: false }) }],
            isError: true,
          };
        }
        log({
          source: 'recall:read_session',
          level: 'info',
          summary: `OK in ${elapsed}ms — ${page.showing_count} of ${page.total_messages} msgs`,
          data: { sessionId, offset, limit, elapsed, total: page.total_messages, returned: page.showing_count },
        });
        // Format timestamps for LLM consumption
        const formattedPage = {
          ...page,
          messages: page.messages.map(m => ({
            ...m,
            date: m.created_at ? formatTimestamp(m.created_at) : undefined,
          })),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ session: formattedPage, found: true }) }],
        };
      } catch (err) {
        const elapsed = Date.now() - t0;
        log({
          source: 'recall:read_session',
          level: 'error',
          summary: `FAIL in ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
          data: { sessionId, offset, limit, elapsed, error: String(err) },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ session: null, found: false, error: String(err) }) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // select_sessions — Batch structured output: record relevant sessions
  // ------------------------------------------------------------------

  const SESSION_PREFIX_RE = /^[0-9a-f]{8}/i;

  /** Resolve a session ID prefix to a full UUID via the messages table. */
  function resolveSessionId(prefix: string): string | null {
    const clean = prefix.trim().replace(/[^0-9a-f-]/gi, '');
    if (clean.length < 8) return null;
    // Already full UUID length — trust it
    if (clean.length >= 36) return clean.slice(0, 36);
    try {
      const row = getDb(getDbPath()).get(
        `SELECT DISTINCT session_id FROM messages WHERE session_id LIKE ? LIMIT 1`,
        [`${clean}%`],
      ) as { session_id: string } | undefined;
      return row?.session_id ?? null;
    } catch {
      return null;
    }
  }

  server.tool(
    'select_sessions',
    'Record one or more sessions as relevant to the query. Pass an array of selections. session_id can be the first 8+ characters — full UUID not required. This is your primary output mechanism.',
    {
      selections: z.array(z.object({
        session_id: z.string().describe('Session ID or 8+ char prefix from search results'),
        date: z.string().optional().default('').describe('Date from search results'),
        topic: z.string().describe('One sentence — what was discussed'),
        evidence: z.string().optional().default('').describe('1-2 direct quotes or snippets'),
        hits: z.number().optional().default(0).describe('additional_matches count'),
      })).describe('Array of relevant sessions to select'),
    },
    async (args) => {
      const selections = args.selections as Array<{
        session_id: string; date: string; topic: string; evidence: string; hits: number;
      }>;
      const accepted: typeof selections = [];
      const warnings: string[] = [];

      for (const s of selections) {
        if (!SESSION_PREFIX_RE.test(s.session_id)) {
          warnings.push(`Skipped "${s.session_id.slice(0, 20)}" — not a valid session ID prefix`);
          continue;
        }
        const resolved = resolveSessionId(s.session_id);
        if (!resolved) {
          warnings.push(`Skipped "${s.session_id.slice(0, 12)}…" — no matching session found`);
          continue;
        }
        accepted.push({ ...s, session_id: resolved });
        log({
          source: 'recall:select_session',
          level: 'info',
          summary: `Selected ${resolved} — ${s.topic.slice(0, 80)}`,
          data: {
            sessionId: resolved,
            date: s.date,
            topic: s.topic,
            evidence: s.evidence,
            hits: s.hits,
          },
        });
      }

      const parts: string[] = [`Selected ${accepted.length} sessions.`];
      if (warnings.length > 0) {
        parts.push(`\n${warnings.length} skipped:\n${warnings.join('\n')}`);
      }
      return {
        content: [{ type: 'text' as const, text: parts.join('') }],
      };
    },
  );

  return server;
}
