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
import type { ChannelMessage } from "../../core/session-channel.js";
import { findSession, resolveSessionPrefix } from "../../core/session-manager.js";
import { parseModelOption } from "../../core/model-utils.js";
import { INTERNAL_MCP_SERVER_NAME } from "./internal.js";
import { log } from "../../core/log.js";
import { parseJsonlFile } from "../../core/adapters/claude/jsonl-reader.js";
import { formatTranscript, formatMessages, type FormattedTranscriptResult } from "../transcript-formatter.js";
import { readSessionMessages, getSessionMessageCount } from "../../core/recall/message-store.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";

// esbuild --loader:.md=text inlines this as a string at build time.
// In tsx (dev/scripts), require() crashes because tsx has no .md loader.
// We defer the attempt to first use so the filesystem fallback can kick in.
let recallAgentPromptText: string | undefined;
let recallAgentPromptAttempted = false;

// ============================================================================
// Recall Agent Prompt
// ============================================================================

// Inlined at build time by esbuild --loader:.md=text.
// Falls back to filesystem read for dev (tsx) if the import yields undefined.
let _recallPromptTemplate: string | undefined;

function getRecallPromptTemplate(): string {
  if (!_recallPromptTemplate) {
    // Try esbuild-inlined string first (built extension).
    // In tsx/dev, the require crashes — try lazily and catch.
    if (!recallAgentPromptAttempted) {
      recallAgentPromptAttempted = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const loaded = require("../prompts/recall-agent.md");
        if (typeof loaded === "string" && loaded.length > 0) {
          recallAgentPromptText = loaded;
        }
      } catch {
        // Expected in tsx — fall through to filesystem read
      }
    }
    if (typeof recallAgentPromptText === "string" && recallAgentPromptText.length > 0) {
      _recallPromptTemplate = recallAgentPromptText;
    } else {
      // Fallback: filesystem read (dev server, scripts, tests)
      const thisDir = __dirname;
      const candidates = [
        resolvePath(thisDir, "../prompts/recall-agent.md"),
        resolvePath(thisDir, "../../src/mcp/prompts/recall-agent.md"),
      ];
      const promptPath = candidates.find((p) => existsSync(p));
      if (!promptPath) {
        throw new Error(
          `recall-agent.md not found. Searched:\n  ${candidates.join("\n  ")}`,
        );
      }
      _recallPromptTemplate = readFileSync(promptPath, "utf-8");
    }
  }
  return _recallPromptTemplate;
}

export function buildRecallPrompt(
  query: string,
): Array<{ type: "text"; text: string }> {
  return [
    {
      type: "text" as const,
      text: getRecallPromptTemplate().replace("{{query}}", query),
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
 * Format collected tool calls into a readable log for the MCP response.
 * Shows what searches were run, what sessions were selected, etc.
 */
function formatToolCallLog(
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result?: string;
  }>,
): string {
  if (toolCalls.length === 0) return "";
  const lines: string[] = [];
  for (const tc of toolCalls) {
    const inputStr = Object.entries(tc.input)
      .map(([k, v]) => {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}: ${s.length > 200 ? s.slice(0, 200) + "…" : s}`;
      })
      .join(", ");
    lines.push(`**${tc.name}**(${inputStr})`);
    if (tc.result) {
      // Indent result, truncate for readability
      const preview =
        tc.result.length > 500 ? tc.result.slice(0, 500) + "…" : tc.result;
      lines.push(`> ${preview.replace(/\n/g, "\n> ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Create the external MCP server with `recall_conversations` and `read_conversation` tools.
 *
 * Two tools:
 * 1. `recall_conversations` — dispatch a child session to search and present relevant sessions
 * 2. `read_conversation` — pure data tool, reads session transcript without agent dispatch
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
        "Search past sessions when you DON'T already have a session ID. Spawns a dedicated agent that searches, reads, and presents relevant sessions with evidence. Expensive (30-120s). Do NOT use when you already have a sessionId (full or prefix like 774b48b8) — use read_conversation instead. Works best with detailed natural-language questions.",
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

            // Collect tool calls from the recall agent for visibility.
            // The caller sees what searches were run and which sessions selected.
            interface ToolCallRecord {
              name: string;
              input: Record<string, unknown>;
              result?: string;
            }
            const toolCalls: ToolCallRecord[] = [];
            const pendingToolUses = new Map<string, ToolCallRecord>();

            const onEntry = (msg: ChannelMessage) => {
              if (msg.type !== "entry" || !msg.entry.message?.content) return;
              const content = msg.entry.message.content;
              if (!Array.isArray(content)) return;
              for (const block of content) {
                if (
                  block.type === "tool_use" &&
                  typeof block.name === "string" &&
                  block.input
                ) {
                  const rec: ToolCallRecord = {
                    name: block.name,
                    input: block.input as Record<string, unknown>,
                  };
                  toolCalls.push(rec);
                  pendingToolUses.set(block.id as string, rec);
                } else if (
                  block.type === "tool_result" &&
                  typeof block.tool_use_id === "string"
                ) {
                  const rec = pendingToolUses.get(block.tool_use_id);
                  if (rec) {
                    // Capture a truncated version of the result for visibility
                    const raw =
                      typeof block.content === "string"
                        ? block.content
                        : Array.isArray(block.content)
                          ? block.content
                              .filter(
                                (b: { type?: string; text?: string }) =>
                                  b.type === "text",
                              )
                              .map(
                                (b: { type?: string; text?: string }) =>
                                  b.text ?? "",
                              )
                              .join("")
                          : "";
                    rec.result =
                      raw.length > 2000 ? raw.slice(0, 2000) + "…" : raw;
                    pendingToolUses.delete(block.tool_use_id);
                  }
                }
              }
            };

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
              onEntry,
            };

            const result = await dispatch.dispatchChild(options);
            const elapsed = Date.now() - t0;

            if (!result) {
              log({
                source: "recall",
                level: "warn",
                summary: `Recall: no response after ${elapsed}ms`,
                data: { query: args.query, elapsed },
              });
              // Still surface tool calls if any were collected before timeout
              const toolLog = formatToolCallLog(toolCalls);
              return textResult(
                toolLog
                  ? `Recall agent timed out.\n\n## Agent activity before timeout\n\n${toolLog}`
                  : "Recall agent timed out or failed to produce a result.",
              );
            }

            const text = result.text ?? "";
            const toolLog = formatToolCallLog(toolCalls);
            log({
              source: "recall",
              level: "info",
              summary: `Recall: OK in ${elapsed}ms — ${text.length} chars, ${toolCalls.length} tool calls`,
              data: {
                query: args.query,
                elapsed,
                chars: text.length,
                toolCalls: toolCalls.length,
              },
            });
            // Prepend tool call log so the caller sees what searches/selections were made
            const fullResponse = toolLog
              ? `## Recall agent activity\n\n${toolLog}\n\n## Recall agent response\n\n${text}`
              : text;
            return textResult(fullResponse);
          } catch (err) {
            const elapsed = Date.now() - t0;
            log({
              source: "recall",
              level: "error",
              summary: `Recall: failed after ${elapsed}ms — ${err instanceof Error ? err.message : String(err)}`,
              data: { query: args.query, elapsed, error: String(err) },
            });
            return textResult(
              `Recall failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      ),
      tool(
        "read_conversation",
        "Read a specific conversation when you HAVE a session ID (full UUID like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx or a short unique prefix like 774b48b8) or file path. No agent dispatch — cheap, instant data retrieval. Use when the user provides a session ID directly, or after recall_conversations finds relevant sessions. Returns formatted conversation text with pagination (offset/limit), tail (last N entries), and budget-based truncation.",
        {
          sessionId: z
            .string()
            .optional()
            .describe(
              "Session ID (from recall results). Reads from indexed SQLite — fast, vendor-agnostic. Preferred over sessionFile.",
            ),
          sessionFile: z
            .string()
            .optional()
            .describe(
              "Absolute path to session JSONL file. Fallback when sessionId is unavailable or session isn't indexed yet.",
            ),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Skip first N entries (0-based). Default: 0"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("Return at most N entries. Default: 50"),
          budget: z
            .number()
            .int()
            .min(1000)
            .optional()
            .describe("Max output characters before truncation. Default: 30000"),
          tail: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Read the last N entries instead of from the start. Overrides offset."),
        },
        async (args) => {
          const source = args.sessionId ?? args.sessionFile ?? "unknown";
          log({
            source: "read_conversation",
            level: "info",
            summary: `read_conversation: ${source}`,
            data: { sessionId: args.sessionId, sessionFile: args.sessionFile, offset: args.offset, limit: args.limit },
          });

          if (!args.sessionId && !args.sessionFile) {
            return textResult("Provide either sessionId or sessionFile.");
          }

          try {
            const limit = args.limit ?? 50;
            const budget = args.budget ?? 30000;

            // Resolve short prefixes to full UUIDs
            const sessionId = args.sessionId
              ? resolveSessionPrefix(args.sessionId)
              : undefined;

            let result: FormattedTranscriptResult;

            if (sessionId) {
              // Preferred path: read from indexed SQLite with server-side pagination
              const total = getSessionMessageCount(sessionId);
              if (total === 0) {
                if (args.sessionFile) {
                  // Fall back to JSONL if session not indexed
                  const entries = parseJsonlFile(args.sessionFile);
                  if (entries.length === 0) {
                    return textResult("Session transcript is empty or could not be parsed.");
                  }
                  let offset = args.offset ?? 0;
                  if (args.tail) offset = Math.max(0, entries.length - args.tail);
                  result = formatTranscript(entries, { offset, limit, budget });
                } else {
                  return textResult(`Session ${sessionId} not found in index.`);
                }
              } else {
                // Compute offset (handling tail) then fetch only the slice we need
                let offset = args.offset ?? 0;
                if (args.tail) offset = Math.max(0, total - args.tail);
                const page = readSessionMessages(sessionId, offset, limit);
                if (!page || page.messages.length === 0) {
                  return textResult(`Session ${sessionId} has no messages at offset ${offset}.`);
                }
                // formatMessages receives only the requested slice — offset=0
                // because the SQL already skipped.
                result = formatMessages(page.messages, { offset: 0, limit, budget });
                // Patch metadata to reflect true position in the full session
                const shown = result.shownEntries;
                result.offset = offset;
                result.totalEntries = total;
                result.truncated = offset + page.messages.length < total;
                result.nextOffset = result.truncated ? offset + page.messages.length : undefined;
                // Rebuild the footer in content so the LLM sees correct pagination
                const separator = '\n────────────────────────────────────────\n';
                const footerIdx = result.content.lastIndexOf(separator);
                const body = footerIdx >= 0 ? result.content.slice(0, footerIdx) : result.content;
                const lastShown = offset + shown - 1;
                let newFooter = `${separator}Showing messages ${offset}–${lastShown} of ${total} (~${body.length} chars)`;
                if (result.truncated) newFooter += `\nNext page: offset=${result.nextOffset}`;
                result.content = body + newFooter;
              }
            } else {
              // Fallback path: parse raw JSONL
              const entries = parseJsonlFile(args.sessionFile!);
              if (entries.length === 0) {
                return textResult("Session transcript is empty or could not be parsed.");
              }
              let offset = args.offset ?? 0;
              if (args.tail) offset = Math.max(0, entries.length - args.tail);
              result = formatTranscript(entries, { offset, limit, budget });
            }

            log({
              source: "read_conversation",
              level: "info",
              summary: `read_conversation: OK — ${result.shownEntries}/${result.totalEntries} entries, ${result.content.length} chars`,
              data: {
                source,
                shown: result.shownEntries,
                total: result.totalEntries,
                chars: result.content.length,
              },
            });

            return textResult(result.content);
          } catch (err) {
            log({
              source: "read_conversation",
              level: "error",
              summary: `read_conversation: failed — ${err instanceof Error ? err.message : String(err)}`,
              data: { source, error: String(err) },
            });
            return textResult(
              `Failed to read transcript: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      ),
    ],
  });
}
