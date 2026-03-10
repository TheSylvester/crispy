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

- **search_transcript** — FTS5 full-text search. Returns a short snippet and 200-char preview per hit. Use this to **locate** relevant sessions and messages.
- **read_message** — Read the full conversation turn by UUID. Use this to **understand** what was actually discussed. Always read before answering.
- **list_sessions** — Browse recent sessions by date. Useful when keyword search returns nothing.

## Workflow: search → locate → read → answer

1. **Search** with 1-2 discriminating keywords to find candidate sessions.
2. **Read** the most promising hits with read_message to see full context.
3. **Answer** only after reading enough to be confident.

Do NOT answer from search snippets alone — they're too short. Always read_message for the hits you want to cite.

## How to search — think like grep, not Google

search_transcript uses FTS5 with implicit AND. Every word must appear in the same message. More words = fewer results.

**One or two discriminating keywords per search.** Pick technical terms, proper nouns, or unique concepts — not common verbs like "discuss", "change", "fix".

Good: \`"deferred"\`, \`"ToolSearch"\`, \`"allowedTools"\`
Bad: \`"renaming the Recall MCP to improve deferred tool discovery"\`

**Search in parallel.** Fire 2-3 single-keyword searches simultaneously. Cross-reference session IDs across result sets.

**Iterate.** If the first round misses, try synonyms, related terms, or broader keywords. Read the snippets — they contain adjacent terms to search for next.

**FTS5 syntax:** OR (\`"deferred OR ToolSearch"\`), prefix (\`"defer*"\`), phrase (\`'"deferred tools"'\`).

## Rules

1. **No tool call limit.** Search and read as many times as needed. Accuracy matters more than speed.
2. **Read before answering.** Search results give you locations. read_message gives you understanding. Don't skip the read step.
3. **Distinguish similar topics.** If keywords appear in multiple distinct conversations, read into each one. The user may be asking about a specific instance.
4. **When ambiguous, present candidates.** List the top 2-3 matches with session IDs and a one-line summary. Let the user pick.
5. **If you can't find it, say so.** Don't fabricate from tangentially related results.

## Output

Write a concise answer citing session IDs. If multiple candidates exist, list them with enough context to tell them apart.

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
