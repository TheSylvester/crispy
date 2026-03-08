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

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { AgentDispatch } from '../../host/agent-dispatch.js';
import type { ChildSessionOptions } from '../../core/session-manager.js';
import { parseModelOption } from '../../core/model-utils.js';
import { INTERNAL_MCP_SERVER_NAME } from './internal.js';

// ============================================================================
// Recall Agent Prompt
// ============================================================================

function buildRecallPrompt(query: string): Array<{ type: 'text'; text: string }> {
  return [{
    type: 'text' as const,
    text: `You are a memory recall agent. Search the user's past session history and provide a concise, helpful answer.

You have 4 MCP tools — use ONLY these, nothing else:
- search_sessions: Full-text search (start here). Use short keywords with OR for broad matches. Results include summaries and snippets — often enough to answer without drilling deeper. Use since/before params to filter by time range.
- list_sessions: Browse recent sessions by date. Use when search returns nothing or the query is about recent/general work.
- session_context: Get structured metadata (titles, quests, summaries) for a session. NOT conversation content.
- read_turn: Read actual conversation content at a byte offset. The only way to see what was said.

Strategy:
1. Search with 1-2 keyword queries (use OR to broaden: "sqlite OR database OR wasm")
2. Read the search results carefully — summaries and snippets often contain the answer
3. Only drill into sessions (session_context or read_turn) if you need specific details
4. Synthesize your answer citing session file paths

Do not narrate what you're about to do — just call tools and then write your answer.

User's query: ${query}`,
  }];
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
 */
export function buildInternalMcpConfig(
  command: string,
  args: string[],
): Record<string, unknown> {
  return {
    [INTERNAL_MCP_SERVER_NAME]: {
      type: 'stdio' as const,
      command,
      args,
    },
  };
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
 * The tool is a relay: dispatch a child session with the internal stdio
 * MCP server attached, let the child search and synthesize, return the
 * result. The child gets 120s and access to the query tools.
 *
 * @param dispatch - AgentDispatch for spawning child sessions
 * @param getActiveSessionId - Returns the current active session ID (for parent anchoring)
 * @param serverPaths - Command and args for the internal MCP server subprocess (resolved by adapter-registry based on host type)
 * @param getRosieModel - Returns the Rosie model setting ("vendor:model" or undefined for default)
 */
export function createExternalServer(
  dispatch: AgentDispatch,
  getActiveSessionId: () => string | undefined,
  serverPaths: { internalServerCommand: string; internalServerArgs: string[] },
  getRosieModel?: () => string | undefined,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'crispy',
    version: '1.0.0',
    tools: [
      tool(
        'recall',
        'Ask a question about your past session history. A dedicated agent searches your sessions, reads conversations, and synthesizes an answer. Use this to remember decisions, find solutions, check what was discussed, or recall context. Works best with detailed natural-language questions — not keyword searches.',
        {
          query: z.string().describe('A natural-language question or request — NOT keywords. Be specific about what you want to know, include any context you have (timeframes, topics, what you vaguely remember). Example: "Why did we choose WASM SQLite over native? I think it was a VS Code packaging constraint." Bad: "sqlite wasm native"'),
        },
        async (args) => {
          console.error(`[recall] Tool handler invoked with query: "${args.query}"`);
          const parentSessionId = getActiveSessionId?.();
          if (!parentSessionId) {
            console.error('[recall] No active session — cannot dispatch child');
            return textResult('Cannot recall: no active session context available.');
          }

          console.error(`[recall] Dispatching child for query: "${args.query}" (parent: ${parentSessionId})`);
          const t0 = Date.now();

          try {
            // Resolve Rosie model — settings override, else default to haiku
            const { vendor: recallVendor, model: parsedModel } = parseModelOption(getRosieModel?.() ?? '');
            const recallModel = parsedModel || 'haiku';

            const options: ChildSessionOptions = {
              parentSessionId,
              vendor: recallVendor,
              parentVendor: 'claude',
              prompt: buildRecallPrompt(args.query),
              settings: {
                model: recallModel,
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
              },
              forceNew: true,
              mcpServers: buildInternalMcpConfig(serverPaths.internalServerCommand, serverPaths.internalServerArgs),
              env: {
                CLAUDECODE: '',                        // Bypass nested Claude Code guard
                CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '120000',  // 120s MCP timeout
              },
              skipPersistSession: true,
              autoClose: true,
              timeoutMs: 120_000,
            };

            const result = await dispatch.dispatchChild(options);
            const elapsed = Date.now() - t0;

            if (!result) {
              console.error(`[recall] Child returned null after ${elapsed}ms — timeout or empty response`);
              return textResult('Recall agent timed out or failed to produce a result.');
            }

            console.error(`[recall] OK in ${elapsed}ms — ${result.text.length} chars`);
            return textResult(result.text);
          } catch (err) {
            const elapsed = Date.now() - t0;
            console.error(`[recall] FAIL after ${elapsed}ms:`, err instanceof Error ? err.message : String(err));
            return textResult(`Recall failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
    ],
  });
}
