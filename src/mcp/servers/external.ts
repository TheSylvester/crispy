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
import { findSession } from '../../core/session-manager.js';
import { parseModelOption } from '../../core/model-utils.js';
import { INTERNAL_MCP_SERVER_NAME } from './internal.js';
import { pushRosieLog } from '../../core/rosie/index.js';
import { pushEventLog } from '../../core/rosie/event-log.js';

// ============================================================================
// Recall Agent Prompt
// ============================================================================

function buildRecallPrompt(query: string): Array<{ type: 'text'; text: string }> {
  return [{
    type: 'text' as const,
    text: `You are a memory recall agent. Search the user's past session history and answer their question.

## Tools

- **search_transcript** — FTS5 full-text search over conversation content. Each result includes a message_preview (up to 4000 chars of actual text — usually the complete message). This is your primary tool.
- **read_message** — Fetch the full user+assistant turn by UUID. ONLY use when a search result has truncated=true AND you need the remaining content. Most messages are under 4000 chars so the preview IS the full message.
- **list_sessions** — Browse recent sessions by date. Use only when search returns nothing.

## Rules — follow these strictly

1. **Use the user's exact terms first.** If they mention "claude-transcript agent", search for "claude-transcript". Do not rephrase or broaden the first query.
2. **Maximum 3 tool calls.** One search usually suffices. A second search with different terms is acceptable if the first returned nothing relevant. A third call (read_message or list_sessions) is the absolute limit. Stop and synthesize after that.
3. **Read the message_preview field.** It contains the actual conversation text. Do NOT call read_message just to see what a search hit says — the preview already has it.
4. **Never search for UUIDs, timestamps, or generic words** like "seconds", "timing", "faster", "comparison". These match everything and return noise.
5. **Stop when you have enough.** If your first search returns relevant results, write your answer. Do not keep searching for more.

## Output

Write a concise answer citing session IDs. If you can't find the information, say so briefly — don't keep searching.

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
      type: 'stdio' as const,
      command,
      args: extraArgs ? [...args, ...extraArgs] : args,
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
 * @param getActiveSession - Returns the current active session's ID and vendor (for parent anchoring)
 * @param serverPaths - Command and args for the internal MCP server subprocess (resolved by adapter-registry based on host type)
 * @param getRosieModel - Returns the Rosie model setting ("vendor:model" or undefined for default)
 */
export function createExternalServer(
  dispatch: AgentDispatch,
  getActiveSession: () => { sessionId: string; vendor: string } | undefined,
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
          pushRosieLog({ source: 'recall', level: 'info', summary: `Recall: query "${args.query.slice(0, 80)}"`, data: { query: args.query } });
          const activeSession = getActiveSession?.();
          if (!activeSession) {
            console.error('[recall] No active session — cannot dispatch child');
            pushRosieLog({ source: 'recall', level: 'warn', summary: 'Recall: no active session for dispatch' });
            return textResult('Cannot recall: no active session context available.');
          }

          console.error(`[recall] Dispatching child for query: "${args.query}" (parent: ${activeSession.sessionId}, vendor: ${activeSession.vendor})`);
          pushRosieLog({ source: 'recall', level: 'info', summary: `Recall: dispatching child (vendor: ${activeSession.vendor})`, data: { parentSessionId: activeSession.sessionId, vendor: activeSession.vendor } });
          pushEventLog({ source: 'recall', summary: `Dispatching child — query="${args.query.slice(0, 120)}"`, data: { query: args.query, vendor: activeSession.vendor, parentSessionId: activeSession.sessionId } });
          const t0 = Date.now();

          try {
            // Resolve Rosie model — settings override, else default to haiku
            const { vendor: recallVendor, model: parsedModel } = parseModelOption(getRosieModel?.() ?? '');
            const recallModel = parsedModel || 'haiku';

            // Derive project scope for search_transcript
            const sessionInfo = findSession(activeSession.sessionId);
            const projectId = sessionInfo?.projectPath ?? '';
            const projectArgs = projectId ? [`--project-id=${projectId}`] : [];

            const options: ChildSessionOptions = {
              parentSessionId: activeSession.sessionId,
              vendor: recallVendor,
              parentVendor: activeSession.vendor,
              prompt: buildRecallPrompt(args.query),
              settings: {
                model: recallModel,
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
              },
              forceNew: true,
              mcpServers: buildInternalMcpConfig(serverPaths.internalServerCommand, serverPaths.internalServerArgs, projectArgs),
              env: {
                CLAUDECODE: '',                        // Bypass nested Claude Code guard
                CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '180000',  // 180s MCP timeout
              },
              skipPersistSession: true,
              autoClose: true,
              timeoutMs: 180_000,
            };

            const result = await dispatch.dispatchChild(options);
            const elapsed = Date.now() - t0;

            if (!result) {
              console.error(`[recall] Child returned null after ${elapsed}ms — timeout or empty response`);
              pushRosieLog({ source: 'recall', level: 'warn', summary: `Recall: no response after ${elapsed}ms`, data: { elapsed } });
              pushEventLog({ source: 'recall', level: 'warn', summary: `No response after ${elapsed}ms`, data: { query: args.query, elapsed } });
              return textResult('Recall agent timed out or failed to produce a result.');
            }

            console.error(`[recall] OK in ${elapsed}ms — ${result.text.length} chars`);
            pushRosieLog({ source: 'recall', level: 'info', summary: `Recall: OK in ${elapsed}ms — ${result.text.length} chars`, data: { elapsed, chars: result.text.length } });
            pushEventLog({ source: 'recall', summary: `OK in ${elapsed}ms — ${result.text.length} chars`, data: { query: args.query, elapsed, chars: result.text.length } });
            return textResult(result.text);
          } catch (err) {
            const elapsed = Date.now() - t0;
            console.error(`[recall] FAIL after ${elapsed}ms:`, err instanceof Error ? err.message : String(err));
            pushRosieLog({ source: 'recall', level: 'error', summary: `Recall: failed after ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`, data: { elapsed, error: String(err) } });
            pushEventLog({ source: 'recall', level: 'error', summary: `Failed after ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`, data: { query: args.query, elapsed, error: String(err) } });
            return textResult(`Recall failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
    ],
  });
}
