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

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { searchSessions, listSessions, sessionContext, readTurnContent, getDbPath, searchTranscript, searchTranscriptMeta, readMessageTurn, grepMessages, readSessionMessages } from '../memory-queries.js';
import type { MessageSearchResult } from '../memory-queries.js';
import { log } from '../../core/log.js';

import { writeTrackerResults, getProjectTitle, mergeProjects, getProjectTextsForEmbedding, getValidStageNames } from '../../core/rosie/tracker/db-writer.js';
import { VALID_TYPES } from '../../core/rosie/tracker/types.js';
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
  tool: 'create_project' | 'track_project' | 'mark_trivial' | 'merge_project';
  action?: 'created' | 'updated' | 'merged';
  title?: string;
  stage?: string;
  status?: string;
  icon?: string;
  reason?: string;
  /** For merge_project: the ID that was kept. */
  keep_id?: string;
  /** For merge_project: the ID that was removed. */
  remove_id?: string;
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
  /** Session ID to exclude from search results (caller's own session). */
  excludeSessionId?: string;
  /** Parent session ID for tracker provenance (which session spawned the tracker). */
  parentSessionId?: string;
}

/** Module-level options — set by createInternalServer(), read by tool handlers. */
let serverOptions: InternalServerOptions = {};

/** Build a SessionRef with the parent session's ID for provenance tracking. */
function buildSessionRef(): { detected_in: string } {
  return { detected_in: serverOptions.parentSessionId ?? '' };
}

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
// Post-write Semantic Validation
// ============================================================================

/** Cosine similarity threshold for duplicate warnings. */
const SIMILARITY_THRESHOLD = 0.85;

/**
 * Check if a newly created project is semantically similar to existing projects.
 * Returns warning strings for any matches above the threshold.
 * Fails silently (returns []) if embeddings are unavailable — never blocks creates.
 */
async function checkSemanticDuplicates(title: string, summary: string, newProjectId?: string): Promise<string[]> {
  try {
    const existing = getProjectTextsForEmbedding();
    // Need at least 2 projects (the new one is already in the DB)
    if (existing.length < 2) return [];

    // Lazy-import embedder to avoid pulling in llama deps at module load
    const { embedBatch } = await import('../../core/recall/embedder.js');
    const { computeNorm, cosineSimilarity } = await import('../../core/recall/quantize.js');

    const newText = summary ? `${title} ${summary}` : title;
    const allTexts = [newText, ...existing.map(p => p.text)];
    const embeddings = await embedBatch(allTexts);

    const newEmb = embeddings[0]!;
    const newNorm = computeNorm(newEmb);
    const warnings: string[] = [];

    for (let i = 1; i < embeddings.length; i++) {
      const proj = existing[i - 1]!;
      // Skip comparing against itself (the just-created project is in the list)
      if (newProjectId && proj.id === newProjectId) continue;

      const sim = cosineSimilarity(newEmb, embeddings[i]!, newNorm, computeNorm(embeddings[i]!));
      if (sim >= SIMILARITY_THRESHOLD) {
        warnings.push(`⚠️ Similar project exists: '${proj.title}' (id: ${proj.id}, similarity: ${sim.toFixed(3)}). Call merge_project to combine if these are the same.`);
      }
    }

    return warnings;
  } catch (err) {
    // Embedding failure must not block creates
    log({ source: 'internal-mcp', level: 'warn',
      summary: `Semantic validation skipped: ${err instanceof Error ? err.message : String(err)}` });
    return [];
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
        content: [{ type: 'text' as const, text: JSON.stringify({ [resultKey]: results, count: results.length }, null, 2) }],
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
  /** Best-scoring result for this session (use its message_id/session_id to drill down). */
  session_id: string;
  message_id: string;
  message_seq: number;
  project_id: string | null;
  created_at: number;
  /** ISO 8601 date string for LLM consumption. */
  date: string;
  message_role: string | null;
  rank: number;
  match_snippet: string;
  message_preview: string;
  truncated: boolean;
  /** How many additional matches exist in this session beyond the primary. */
  additional_matches: number;
  /** Snippets from other matching messages in this session (deduped, up to 3). */
  other_snippets: string[];
}

/**
 * Group search results by session_id. Each session appears once with its
 * best-scoring result as the primary entry, plus snippets from other matches.
 * This ensures the agent sees maximum session diversity instead of 5 results
 * from the same session eating top-20 slots.
 */
function groupBySession(results: MessageSearchResult[]): GroupedResult[] {
  const groups = new Map<string, { primary: MessageSearchResult; others: MessageSearchResult[] }>();

  for (const r of results) {
    const existing = groups.get(r.session_id);
    if (!existing) {
      groups.set(r.session_id, { primary: r, others: [] });
    } else {
      existing.others.push(r);
    }
  }

  return [...groups.values()].map(({ primary, others }) => ({
    session_id: primary.session_id,
    message_id: primary.message_id,
    message_seq: primary.message_seq,
    project_id: primary.project_id,
    created_at: primary.created_at,
    date: formatTimestamp(primary.created_at),
    message_role: primary.message_role,
    rank: primary.rank,
    match_snippet: primary.match_snippet,
    message_preview: primary.message_preview,
    truncated: primary.truncated,
    additional_matches: others.length,
    other_snippets: others.slice(0, 3).map(o => o.match_snippet).filter(Boolean),
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

  // Build dynamic stage enum from DB (read once at server creation time)
  // getValidStageNames() is guaranteed non-empty (falls back to VALID_STAGES)
  const rawStageNames = getValidStageNames();
  const stageNames: [string, ...string[]] = [rawStageNames[0]!, ...rawStageNames.slice(1)];

  // ------------------------------------------------------------------
  // search_sessions — FTS5 search over activity entries
  // ------------------------------------------------------------------
  const runSearch = wrapToolHandler('search_sessions', 'results',
    (query: string, limit: number, kind?: string, since?: string, before?: string) => searchSessions(dbPath, query, limit, kind, since, before, serverOptions.excludeSessionId),
  );

  timedTool(server,
    'search_sessions',
    'Full-text search over session activity. Returns BM25-ranked results with match snippets and previews. Start here for most queries. Supports FTS5 syntax: use OR for broad searches ("sqlite OR database"), "quoted phrases" for exact matches, prefix* for partial terms. Supports time filtering with since/before.',
    {
      query: z.string().describe('Search query — use OR to broaden, "quoted phrases" for exact matches, prefix* for partial terms. Prefer short keywords over long natural-language phrases.'),
      limit: z.number().optional().default(20).describe('Maximum results to return (default 20)'),
      since: z.string().optional().describe('ISO timestamp — only return results after this time (e.g. "2026-03-01T00:00:00Z")'),
      before: z.string().optional().describe('ISO timestamp — only return results before this time'),
    },
    async (args) => {
      log({ level: 'debug', source: 'recall:search_sessions', summary: `query="${args.query}" limit=${args.limit} since=${args.since ?? '-'} before=${args.before ?? '-'}` });
      return runSearch(args.query as string, args.limit as number, undefined, args.since as string | undefined, args.before as string | undefined);
    },
  );

  // ------------------------------------------------------------------
  // list_sessions — List distinct sessions with latest metadata
  // ------------------------------------------------------------------
  const runList = wrapToolHandler('list_sessions', 'sessions',
    (limit: number, since?: string) => listSessions(dbPath, limit, since, serverOptions.excludeSessionId),
  );

  timedTool(server,
    'list_sessions',
    'Browse sessions by recency — use when you need to scan recent work without a specific search term, or when search returns nothing and you want to browse what exists.',
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
  // session_context — Full activity history for a specific session
  // ------------------------------------------------------------------
  const runContext = wrapToolHandler('session_context', 'entries',
    (file: string, kind?: string) => sessionContext(dbPath, file, kind, serverOptions.excludeSessionId),
  );

  timedTool(server,
    'session_context',
    'Get the activity index for a specific session — returns timestamped prompt entries in chronological order. This is structured metadata, NOT the raw conversation. Use read_turn to get actual conversation content.',
    {
      file: z.string().describe('Session transcript file path (from search_sessions or list_sessions results)'),
    },
    async (args) => {
      log({ level: 'debug', source: 'recall:session_context', summary: `file="${args.file}"` });
      return runContext(args.file as string);
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
            content: [{ type: 'text' as const, text: JSON.stringify({ turn: null, found: false }, null, 2) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ turn: result, found: true }, null, 2) }],
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
          }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // create_project — Create a new tracked project
  // ------------------------------------------------------------------
  server.tool(
    'create_project',
    'Create a new project based on this session\'s work. Use for NEW work that doesn\'t match any existing project.',
    {
      title: z.string().describe('Short, stable project title. Keep consistent across sessions.'),
      stage: z.enum(stageNames).describe('Project lifecycle stage — see Available Stages in system prompt for descriptions and usage guidance.'),
      status: z.string().describe('Freeform status line — what is true RIGHT NOW in 1-2 sentences.'),
      icon: z.string().describe('Single emoji representing the project domain (e.g. 🔧, 📊, 🎨).'),
      summary: z.string().describe('Stable description of what this project IS. Set once, rarely changed.'),
      type: z.enum(VALID_TYPES).default('project').describe('Project type: project (default), task (sub-item of a project), idea (not yet a project).'),
      parent_id: z.string().optional().describe('Parent project UUID. Required when type is \'task\'.'),
      blocked_by: z.string().optional().describe('Why it\'s blocked (only if stage is \'paused\', otherwise omit).'),
      branch: z.string().optional().describe('Git branch name if applicable.'),
      files: z.array(z.object({
        path: z.string().describe('File path to a non-code artifact.'),
        note: z.string().describe('Why this file is relevant.'),
      })).optional().describe('Non-code artifacts only: plans, specs, design docs. NOT source code. Omit if none.'),
    },
    async (args) => {
      // Validate: type='task' requires parent_id
      if (args.type === 'task' && !args.parent_id) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: "type 'task' requires parent_id — provide the UUID of the parent project." }) }],
          isError: true,
        };
      }

      const sessionFile = serverOptions.sessionFile ?? process.env.CRISPY_TRACKER_SESSION_FILE;
      if (!sessionFile) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: 'Session file not configured' }) }],
          isError: true,
        };
      }

      const projectId = randomUUID();
      const block: TrackerBlock = {
        project: {
          action: 'create',
          id: projectId,
          title: args.title,
          stage: args.stage,
          status: args.status,
          icon: args.icon,
          blocked_by: args.blocked_by ?? '',
          summary: args.summary,
          branch: args.branch ?? '',
          type: args.type,
          parent_id: args.parent_id,
        },
        sessionRef: buildSessionRef(),
        files: (args.files ?? []).map((f) => ({ path: f.path, note: f.note })),
      };

      try {
        writeTrackerResults([block], sessionFile);
        log({ level: 'debug', source: 'recall:create_project', summary: `created "${args.title}" [${args.stage}] type=${args.type}` });
        appendDecision({ tool: 'create_project', action: 'created', title: args.title, stage: args.stage, status: args.status, icon: args.icon });

        // Post-write semantic validation — warn if similar project exists
        const warnings = await checkSemanticDuplicates(args.title, args.summary, projectId);
        const result: Record<string, unknown> = { status: 'ok', action: 'created', project: args.title, projectId };
        const content: Array<{ type: 'text'; text: string }> = [
          { type: 'text' as const, text: JSON.stringify(result) },
        ];
        if (warnings.length > 0) {
          content.push({ type: 'text' as const, text: warnings.join('\n') });
        }
        return { content };
      } catch (err) {
        log({ level: 'error', source: 'recall:create_project', summary: `FAIL: ${err instanceof Error ? err.message : String(err)}`, data: { error: err instanceof Error ? err.message : String(err) } });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: `create_project failed: ${err instanceof Error ? err.message : String(err)}` }) }],
          isError: true,
        };
      }
    },
  );

  // ------------------------------------------------------------------
  // track_project — Update an existing tracked project
  // ------------------------------------------------------------------
  server.tool(
    'track_project',
    'Update an existing project with this session\'s work. Provide only fields that changed. Always auto-links the current session.',
    {
      project_id: z.string().describe('UUID of the existing project. Must match an id from the existing projects list.'),
      status: z.string().optional().describe('Updated freeform status line — only if changed.'),
      stage: z.enum(stageNames).optional().describe('Updated stage — only if changed. See Available Stages in system prompt.'),
      blocked_by: z.string().optional().describe('Why it\'s blocked (only if stage is \'paused\').'),
      branch: z.string().optional().describe('Git branch name if applicable.'),
      files: z.array(z.object({
        path: z.string().describe('File path to a non-code artifact.'),
        note: z.string().describe('Why this file is relevant.'),
      })).optional().describe('Non-code artifacts only. Omit if none.'),
    },
    async (args) => {
      const sessionFile = serverOptions.sessionFile ?? process.env.CRISPY_TRACKER_SESSION_FILE;
      if (!sessionFile) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: 'Session file not configured' }) }],
          isError: true,
        };
      }

      const block: TrackerBlock = {
        project: {
          action: 'track',
          id: args.project_id,
          ...(args.status !== undefined && { status: args.status }),
          ...(args.stage !== undefined && { stage: args.stage }),
          ...(args.blocked_by !== undefined && { blocked_by: args.blocked_by }),
          ...(args.branch !== undefined && { branch: args.branch }),
        },
        sessionRef: buildSessionRef(),
        files: (args.files ?? []).map((f) => ({ path: f.path, note: f.note })),
      };

      try {
        writeTrackerResults([block], sessionFile);
        // Look up the project title for decision logging (UUID is not user-friendly)
        const projectTitle = getProjectTitle(args.project_id)?.title ?? args.project_id;
        log({ level: 'debug', source: 'recall:track_project', summary: `updated "${projectTitle}"` });
        appendDecision({ tool: 'track_project', action: 'updated', title: projectTitle, stage: args.stage, status: args.status });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', action: 'updated', projectId: args.project_id }) }],
        };
      } catch (err) {
        log({ level: 'error', source: 'recall:track_project', summary: `FAIL: ${err instanceof Error ? err.message : String(err)}`, data: { error: err instanceof Error ? err.message : String(err) } });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: `track_project failed: ${err instanceof Error ? err.message : String(err)}` }) }],
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
      log({ level: 'debug', source: 'recall:mark_trivial', summary: `"${args.reason}"` });
      appendDecision({ tool: 'mark_trivial', reason: args.reason });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', trivial: true, reason: args.reason }) }],
      };
    },
  );

  // ------------------------------------------------------------------
  // merge_project — Merge two projects into one
  // ------------------------------------------------------------------
  server.tool(
    'merge_project',
    'Merge two projects that represent the same work. Keeps one, removes the other. Reparents child tasks, migrates sessions and files.',
    {
      keep_id: z.string().describe('UUID of the project to keep (survivor).'),
      remove_id: z.string().describe('UUID of the project to remove (merged into survivor).'),
    },
    async (args) => {
      if (args.keep_id === args.remove_id) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: 'keep_id and remove_id must be different' }) }],
          isError: true,
        };
      }

      const keepInfo = getProjectTitle(args.keep_id);
      const removeInfo = getProjectTitle(args.remove_id);

      if (!keepInfo || !removeInfo) {
        const missing = !keepInfo ? args.keep_id : args.remove_id;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: `Project not found: ${missing}` }) }],
          isError: true,
        };
      }

      try {
        mergeProjects(args.keep_id, args.remove_id);
        log({ source: 'internal-mcp', level: 'info',
          summary: `merge_project: merged "${removeInfo.title}" → "${keepInfo.title}"` });
        appendDecision({ tool: 'merge_project', action: 'merged', title: keepInfo.title, keep_id: args.keep_id, remove_id: args.remove_id });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'ok', action: 'merged', kept: keepInfo.title, removed: removeInfo.title }) }],
        };
      } catch (err) {
        log({ source: 'internal-mcp', level: 'error',
          summary: `merge_project FAIL: ${err instanceof Error ? err.message : String(err)}` });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: `merge_project failed: ${err instanceof Error ? err.message : String(err)}` }) }],
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
    'Dual-path search (FTS5 keywords + semantic embeddings, falls back to FTS5-only if embeddings unavailable) over raw conversation content. Results are grouped by session — each session appears once with its best match plus additional snippets, so you see maximum session diversity. Returns session ID, message UUID, highlighted snippet, short preview (up to 200 chars), additional_matches count, and other_snippets. Also returns total_matches and session_hits. Project-scoped by default. Supports FTS5 syntax: OR for broad searches, "quoted phrases" for exact matches, prefix* for partial terms. Use read_message to drill into a specific result.',
    {
      query: z.string().describe('Search query — short keywords work best. Use OR to broaden: "sqlite OR database"'),
      limit: z.number().optional().default(40).describe('Maximum grouped session results (default 40)'),
      session_id: z.string().optional().describe('Scope search to a single session (use after broad search to drill into a specific session)'),
      all_projects: z.boolean().optional().default(false).describe('Search across all projects instead of just the current workspace'),
    },
    async (args) => {
      const query = args.query as string;
      const limit = args.limit as number;
      const projectId = args.all_projects ? undefined : serverOptions.projectId;
      const sessionId = args.session_id as string | undefined;
      log({ level: 'debug', source: 'recall:search_transcript', summary: `query="${query}" limit=${limit} project=${projectId ?? 'all'} session=${sessionId ?? 'all'}` });
      const t0 = Date.now();
      try {
        const results = await searchTranscript(query, limit, projectId, sessionId, serverOptions.excludeSessionId);
        const meta = searchTranscriptMeta(query, projectId, sessionId, serverOptions.excludeSessionId);
        const elapsed = Date.now() - t0;
        log({
          source: 'recall:search_transcript',
          level: 'info',
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
        });
        // Group results by session — each session appears once with all its
        // unique snippets, so the agent sees more diverse sessions.
        const grouped = groupBySession(results);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            results: grouped,
            count: grouped.length,
            total_matches: meta.total_matches,
            session_hits: meta.session_hits,
          }, null, 2) }],
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
      log({ level: 'debug', source: 'recall:read_message', summary: `session=${sessionId} message=${messageId} context=${ctx}` });
      const t0 = Date.now();
      try {
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
            content: [{ type: 'text' as const, text: JSON.stringify({ turn: null, found: false }, null, 2) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ turn: result, found: true }, null, 2) }],
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
          }, null, 2) }],
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
          }, null, 2) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ matches: [], error: String(err) }, null, 2) }],
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
            content: [{ type: 'text' as const, text: JSON.stringify({ session: null, found: false }, null, 2) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ session: formattedPage, found: true }, null, 2) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify({ session: null, found: false, error: String(err) }, null, 2) }],
          isError: true,
        };
      }
    },
  );

  return server;
}
