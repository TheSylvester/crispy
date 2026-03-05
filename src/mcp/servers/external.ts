/**
 * External MCP Server — `recall` tool as a dumb relay.
 *
 * In-process MCP server (Claude SDK) exposing a single `recall` tool.
 * The tool fetches raw search results from the activity database, stuffs
 * them into a prompt, dispatches a Rosie-style child session (no MCP
 * servers, no nested Claude Code), and returns the synthesized answer.
 *
 * The MCP server itself has zero intelligence — it's a relay between
 * the caller and an ephemeral child session that does the thinking.
 *
 * @module mcp/servers/external
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { AgentDispatch } from '../../host/agent-dispatch.js';
import { searchSessions, listSessions, sessionContext, getDbPath } from '../memory-queries.js';
import type { SearchResult } from '../memory-queries.js';

// ============================================================================
// Data Fetching — pure queries, no intelligence
// ============================================================================

/**
 * Fetch relevant session data for a recall query.
 *
 * Searches the activity DB, then pulls full context for the top sessions.
 * Returns a formatted text block ready to stuff into a prompt.
 */
function fetchContextForQuery(query: string): string {
  const dbPath = getDbPath();
  const searchResults = searchSessions(dbPath, query, 15);

  if (searchResults.length === 0) {
    // Fall back to recent sessions — the query might not match FTS terms
    const recent = listSessions(dbPath, 10);
    if (recent.length === 0) return 'No session data found in the activity database.';

    return `No direct search matches for "${query}". Here are the most recent sessions:\n\n`
      + recent.map((s) =>
        `- ${s.title || s.quest || '(untitled)'} [${s.last_activity}] (${s.entry_count} entries) — ${s.file}`
      ).join('\n');
  }

  // Group results by session file — drill into the top 3 distinct sessions
  const seenFiles = new Set<string>();
  const topFiles: string[] = [];
  for (const r of searchResults) {
    if (!seenFiles.has(r.file)) {
      seenFiles.add(r.file);
      topFiles.push(r.file);
      if (topFiles.length >= 3) break;
    }
  }

  const parts: string[] = [];

  // Search results overview
  parts.push(`## Search Results for "${query}" (${searchResults.length} matches)\n`);
  parts.push(formatSearchResults(searchResults));

  // Drill into top sessions
  for (const file of topFiles) {
    const context = sessionContext(dbPath, file, 'rosie-meta');
    if (context.length === 0) continue;

    const label = context.find((c) => c.title)?.title
      || context.find((c) => c.quest)?.quest
      || file.split('/').pop();

    parts.push(`\n## Session: ${label}\n`);
    for (const entry of context.slice(-5)) { // Last 5 entries for recency
      const lines: string[] = [];
      if (entry.quest) lines.push(`Quest: ${entry.quest}`);
      if (entry.summary) lines.push(`Summary: ${entry.summary}`);
      if (entry.status) lines.push(`Status: ${entry.status}`);
      if (entry.entities) lines.push(`Entities: ${entry.entities}`);
      if (lines.length > 0) {
        parts.push(`[${entry.timestamp}]\n${lines.join('\n')}`);
      }
    }
  }

  return parts.join('\n');
}

function formatSearchResults(results: SearchResult[]): string {
  return results.map((r) => {
    const label = r.title || r.quest || '(untitled)';
    return `- **${label}** [${r.kind}, ${r.timestamp}] — ${r.match_snippet}`;
  }).join('\n');
}

// ============================================================================
// Recall Prompt
// ============================================================================

function buildRecallPrompt(
  query: string,
  context: string,
): Array<{ type: 'text'; text: string }> {
  return [{
    type: 'text' as const,
    text: `You are a memory recall agent. The user wants to remember something from past sessions. Answer their query using ONLY the session data provided below. Be concise and specific.

If the data doesn't contain a clear answer, say so — don't speculate.

## User's Query
${query}

## Session Data
${context}`,
  }];
}

// ============================================================================
// Helpers
// ============================================================================

function textResult(data: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: data }] };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create the external MCP server with the `recall` tool.
 *
 * The tool is a relay: fetch data → build prompt → dispatch child → return.
 * No MCP servers are attached to the child session. No nested Claude Code.
 *
 * @param dispatch - AgentDispatch for spawning child sessions
 * @param getActiveSessionId - Returns the current active session ID (for parent anchoring)
 */
export function createExternalServer(
  dispatch: AgentDispatch,
  getActiveSessionId?: () => string | undefined,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'crispy',
    version: '1.0.0',
    tools: [
      tool(
        'recall',
        'Search your past session history and get synthesized answers. Use this to remember what you worked on, find previous solutions, or recall context from earlier sessions.',
        {
          query: z.string().describe('What to search for — describe what you want to recall from past sessions'),
        },
        async (args) => {
          const parentSessionId = getActiveSessionId?.();
          if (!parentSessionId) {
            return textResult('Cannot recall: no active session context available.');
          }

          try {
            // 1. Fetch raw data — pure SQLite queries, instant
            const context = fetchContextForQuery(args.query);

            // 2. Dispatch child session — Rosie-style, no MCP, no env hacks
            const result = await dispatch.dispatchChild({
              parentSessionId,
              vendor: 'claude',
              parentVendor: 'claude',
              prompt: buildRecallPrompt(args.query, context),
              settings: { model: 'haiku' },
              skipPersistSession: true,
              autoClose: true,
              timeoutMs: 30_000,
            });

            if (!result) {
              return textResult('Recall agent timed out or failed to produce a result.');
            }
            return textResult(result.text);
          } catch (err) {
            return textResult(`Recall failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
    ],
  });
}
