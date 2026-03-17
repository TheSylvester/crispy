/**
 * External MCP Server — `recall` tool as a dumb relay.
 *
 * In-process MCP server (Claude SDK) exposing a single `recall` tool.
 * The tool dispatches an ephemeral child session with the internal stdio
 * MCP server attached, giving the child agent access to search tools.
 * The child does its own multi-step reasoning (search → drill → synthesize)
 * and the relay returns whatever it produces.
 *
 * The MCP server itself has zero intelligence — it's a relay between
 * the caller and an ephemeral child session that does the thinking.
 *
 * @module mcp/servers/external
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { AgentDispatch } from "../../host/agent-dispatch.js";
import type { ChildSessionOptions } from "../../core/session-manager.js";
import { findSession } from "../../core/session-manager.js";
import { parseModelOption } from "../../core/model-utils.js";
import { INTERNAL_MCP_SERVER_NAME } from "./internal.js";
import { log } from "../../core/log.js";

// ============================================================================
// Recall Agent Prompt
// ============================================================================

export function buildRecallPrompt(
  query: string,
): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text" as const,
      text: `You are a session search agent. Find all sessions relevant to the user's query and present them with evidence. Do not synthesize an answer — the caller will decide which sessions to explore further.

## Tools

- **search_transcript** — FTS5 full-text search (fast, indexed). Returns matching messages with \`session_id\`, \`message_id\`, \`message_seq\`, snippet, and preview. Also returns **total_matches** and **session_hits** (per-session hit counts). Use \`session_id\` param to search within one session.
- **grep** — Regex search over clean message text. Returns \`session_id\`, \`message_id\`, \`message_seq\`, and a context snippet. Use when FTS5 misses — finds substrings, patterns, and near-matches.
- **read_message** — Read a specific turn by \`session_id\` + \`message_id\` (from search/grep results). Use \`context\` (1-5) to see surrounding turns. This is your primary drill-down tool after searching.
- **read_session** — Read messages sequentially with offset/limit pagination. Use \`message_seq\` from search results as the offset to jump directly to the relevant part of a session. Also useful for browsing a session's narrative flow.
- **list_sessions** — Browse recent sessions by date. Useful when search returns nothing or when the query has time signals.

## Workflow

1. **If the query has time signals** ("recently", "last week", "a while ago"), use **list_sessions** first to establish a date range and narrow the search window.
2. **search_transcript** with multiple keyword variations in parallel. Cast a wide net — synonyms, related terms, different phrasings.
3. **Inspect session_hits** — every session with hits is a candidate. Do not discard any yet.
4. **read_message** with \`context: 2-3\` for each candidate session — verify what the session is actually about. For broader context, use **read_session** with \`offset\` set to the \`message_seq\` from search results.
5. **grep** when search_transcript misses — try synonyms, related terms, or substring patterns. A keyword search for "bypass" won't find "intermediary" but grep for \`"ToolSearch"\` will find every message mentioning it regardless of surrounding words.
6. **Present all candidates** with evidence snippets. Do not synthesize an answer.

## How to search

**search_transcript** uses dual-path search (FTS5 keywords + semantic embeddings). It handles vocabulary mismatches better than pure keyword search, but explicit synonym expansion still helps. Use 1-2 technical terms, proper nouns, or unique identifiers.

**Query expansion:** Always search with multiple phrasings. If your first query returns few results, think about what OTHER words the user might have used for the same concept:
- Technical synonyms: "preview" → "snippet", "excerpt", "truncate"
- Abstraction levels: "RRF" → "reciprocal rank fusion" → "merge search results"
- Related concepts: "authentication" → "auth", "login", "credentials", "session token"
- Run 2-3 parallel search_transcript calls with different keyword variations in a single step.

**grep** is slower but flexible. Use when:
- FTS5 returned nothing or wrong results — try different vocabulary
- You need substring matching (\`"crispy.*rename"\`)
- You found one keyword but need to find messages using different words for the same concept

**Iterate.** Read snippets and context carefully — they contain adjacent terms you can search for next. If "bypass" doesn't match, try "intermediary", "workaround", "skip", "avoid".

## Rules

1. **Read before reporting.** Search results give you locations. read_message (with context) gives you understanding. Verify each candidate before including it.
2. **Check every session.** If session_hits shows hits in multiple sessions, sample-read from each one.
3. **When FTS5 fails, grep.** Don't give up after keyword search — the information may be there under different words.
4. **Filter meta-sessions.** Distinguish sessions where the topic itself was discussed (primary sources) from sessions where someone was *searching for or referencing* that topic (meta-sessions). Label meta-sessions clearly — they're usually less relevant than the original discussion.
5. **Prefer recent when ties exist.** When multiple sessions match equally well and the query implies recency, rank newer sessions higher. Always include dates so the caller can judge.
6. **If you can't find it after a thorough search, say so.** Don't fabricate. Report what you did find and suggest alternative search terms.
7. **Watch for timer warnings.** Search thoroughly until your tools show a time warning, then wrap up quickly. After tools lock out, format results immediately from what you have — partial results beat timing out with nothing.

## Output

For each relevant session, return:
- **Session ID** (complete)
- **Date**
- **What was discussed** (one sentence)
- **Evidence** (1-2 direct quotes or snippets from the session)
- **Meta-session?** (yes/no — is this a primary discussion or a later reference?)

List all candidates, most relevant first. Include every session with plausible relevance.

User's query: ${query}`,
    },
  ];
}

// ============================================================================
// Internal MCP Server Config
// ============================================================================

/**
 * Build the MCP server config for the internal stdio server.
 *
 * Paths are always provided by adapter-registry.ts, which resolves them
 * based on host type (VS Code → bundled dist/internal-mcp.js + node,
 * dev server → tsx + TypeScript source). No fallbacks here.
 *
 * @param extraArgs - Additional CLI args appended after the base args.
 *   Used by tracker to pass --session-file and --decisions-file as CLI
 *   args instead of env vars, which works for any adapter's MCP subprocess.
 */
export function buildInternalMcpConfig(
  command: string,
  args: string[],
  extraArgs?: string[],
): Record<string, unknown> {
  return {
    [INTERNAL_MCP_SERVER_NAME]: {
      type: "stdio" as const,
      command,
      args: extraArgs ? [...args, ...extraArgs] : args,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function textResult(data: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text" as const, text: data }] };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create the external MCP server with the `recall` tool.
 *
 * The tool is a relay: dispatch a child session with the internal stdio
 * MCP server attached, let the child search and synthesize, return the
 * result. The child gets 120s and access to the query tools.
 *
 * @param dispatch - AgentDispatch for spawning child sessions
 * @param callerSession - The session that owns this MCP server instance (for parent anchoring and self-filtering)
 * @param serverPaths - Command and args for the internal MCP server subprocess (resolved by adapter-registry based on host type)
 * @param getRosieModel - Returns the Rosie model setting ("vendor:model" or undefined for default)
 */
export function createExternalServer(
  dispatch: AgentDispatch,
  callerSession: { sessionId: string; vendor: string },
  serverPaths: { internalServerCommand: string; internalServerArgs: string[] },
  getRosieModel?: () => string | undefined,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "memory",
    version: "1.0.0",
    tools: [
      tool(
        "recall_conversations",
        "Ask a question about your past session history. A dedicated agent searches your sessions, reads conversations, and synthesizes an answer. Use this to remember decisions, find solutions, check what was discussed, or recall context. Works best with detailed natural-language questions — not keyword searches.",
        {
          query: z
            .string()
            .describe(
              'A natural-language question or request — NOT keywords. Be specific about what you want to know, include any context you have (timeframes, topics, what you vaguely remember). Example: "Why did we choose WASM SQLite over native? I think it was a VS Code packaging constraint." Bad: "sqlite wasm native"',
            ),
        },
        async (args) => {
          log({
            source: "recall",
            level: "info",
            summary: `Recall: query "${args.query.slice(0, 80)}"`,
            data: { query: args.query },
          });
          const activeSession = callerSession;
          if (!activeSession) {
            log({
              source: "recall",
              level: "warn",
              summary: "Recall: no active session for dispatch",
            });
            return textResult(
              "Cannot recall: no active session context available.",
            );
          }

          log({
            source: "recall",
            level: "info",
            summary: `Recall: dispatching child (vendor: ${activeSession.vendor})`,
            data: {
              parentSessionId: activeSession.sessionId,
              vendor: activeSession.vendor,
            },
          });
          log({
            source: "recall",
            level: "info",
            summary: `Dispatching child — query="${args.query.slice(0, 120)}"`,
            data: {
              query: args.query,
              vendor: activeSession.vendor,
              parentSessionId: activeSession.sessionId,
            },
          });
          const t0 = Date.now();

          try {
            // Resolve Rosie model — settings override, else default to haiku
            const { vendor: recallVendor, model: parsedModel } =
              parseModelOption(getRosieModel?.() ?? "");
            const recallModel = parsedModel || "haiku";

            // Derive project scope for search_transcript
            const sessionInfo = findSession(activeSession.sessionId);
            const projectId = sessionInfo?.projectPath ?? "";
            const projectArgs = projectId ? [`--project-id=${projectId}`] : [];

            // Self-filtering: exclude the calling session from search results
            // so the recall agent doesn't find its own conversation.
            const excludeArgs = [`--exclude-session-id=${activeSession.sessionId}`];

            const deadlineMs = Date.now() + 120_000; // last third of 180s reserved for synthesis

            const options: ChildSessionOptions = {
              parentSessionId: activeSession.sessionId,
              vendor: recallVendor,
              parentVendor: activeSession.vendor,
              prompt: buildRecallPrompt(args.query),
              settings: {
                model: recallModel,
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
              },
              forceNew: true,
              mcpServers: buildInternalMcpConfig(
                serverPaths.internalServerCommand,
                serverPaths.internalServerArgs,
                [...projectArgs, ...excludeArgs, `--deadline-ms=${deadlineMs}`],
              ),
              env: {
                CLAUDECODE: "", // Bypass nested Claude Code guard
                CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "180000", // 180s MCP timeout
              },
              skipPersistSession: true,
              autoClose: true,
              timeoutMs: 180_000,
            };

            const result = await dispatch.dispatchChild(options);
            const elapsed = Date.now() - t0;

            if (!result) {
              log({
                source: "recall",
                level: "warn",
                summary: `Recall: no response after ${elapsed}ms`,
                data: { elapsed },
              });
              log({
                source: "recall",
                level: "warn",
                summary: `No response after ${elapsed}ms`,
                data: { query: args.query, elapsed },
              });
              return textResult(
                "Recall agent timed out or failed to produce a result.",
              );
            }

            log({
              source: "recall",
              level: "info",
              summary: `Recall: OK in ${elapsed}ms — ${result.text.length} chars`,
              data: { elapsed, chars: result.text.length },
            });
            log({
              source: "recall",
              level: "info",
              summary: `OK in ${elapsed}ms — ${result.text.length} chars`,
              data: { query: args.query, elapsed, chars: result.text.length },
            });
            return textResult(result.text);
          } catch (err) {
            const elapsed = Date.now() - t0;
            log({
              source: "recall",
              level: "error",
              summary: `Recall: failed after ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
              data: { elapsed, error: String(err) },
            });
            log({
              source: "recall",
              level: "error",
              summary: `Failed after ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
              data: { query: args.query, elapsed, error: String(err) },
            });
            return textResult(
              `Recall failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      ),
    ],
  });
}
