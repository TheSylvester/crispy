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

// ============================================================================
// Recall Agent Prompt
// ============================================================================

function buildRecallPrompt(query: string): Array<{ type: 'text'; text: string }> {
  return [{
    type: 'text' as const,
    text: `You are a memory recall agent. Your job is to search the user's past session history and provide a concise, helpful answer to their query.

You have access to MCP tools for searching session memory:
- mcp__crispy_memory__search_sessions: Full-text search over session activity
- mcp__crispy_memory__list_sessions: List sessions by recency
- mcp__crispy_memory__session_context: Get detailed context for a specific session
- mcp__crispy_memory__read_turn: Read the full user prompt and assistant response at a specific byte offset

You have NO other tools. Do not attempt to read files, run commands, or use any tool besides the ones listed above.

Strategy:
1. Start by searching for the query topic using search_sessions
2. If results look promising, drill into specific sessions using session_context for metadata,
   or read_turn to see the exact conversation content
3. Synthesize a concise answer from what you find

Always cite which session(s) you found information in — include the session file path from the search results so the caller can reference the source.

If you find nothing relevant, say so clearly.

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
function buildInternalMcpConfig(
  command: string,
  args: string[],
): Record<string, unknown> {
  return {
    'crispy-memory': {
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
        'Search your past session history and get synthesized answers. Use this to remember what you worked on, find previous solutions, or recall context from earlier sessions.',
        {
          query: z.string().describe('What to search for — describe what you want to recall from past sessions'),
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
