/**
 * Sub-Agent Transcript Loader
 *
 * Reads sub-agent JSONL files from the `subagents/` directory adjacent to
 * a main session file, adapts them to universal TranscriptEntry format,
 * and injects `parentToolUseID` so the webview can group them under their
 * parent Task tool card.
 *
 * Responsibilities:
 * - Scan main entries for Task tool_result entries with `agentId`
 * - Resolve agentId → sub-agent JSONL file on disk
 * - Adapt sub-agent entries and inject parentToolUseID
 * - Strip duplicate progress entries from the main stream
 * - Handle recursive nesting (sub-agents spawning sub-agents, depth ≤ 5)
 *
 * Does NOT:
 * - Modify the main session file on disk
 * - Handle live streaming (that's session-channel's job)
 * - Touch any webview or rendering logic
 *
 * @module subagent-loader
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { parseJsonlFile } from './jsonl-reader.js';
import { adaptClaudeEntries } from './claude-entry-adapter.js';
import type { TranscriptEntry } from '../../transcript.js';

// ============================================================================
// Types
// ============================================================================

/** Maps a sub-agent's agentId to the parent Task tool_use_id. */
interface AgentMapping {
  agentId: string;
  parentToolUseID: string;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Scan adapted entries for Task tool_result entries that reference a sub-agent.
 *
 * A Task tool_result entry has:
 * - `toolUseResult.agentId` (string) — identifies the sub-agent
 * - `message.content` containing a `tool_result` block whose `tool_use_id`
 *   is the parent Task's tool_use_id
 *
 * @param entries - Adapted TranscriptEntry array to scan
 * @returns Array of agentId → parentToolUseID mappings
 */
function extractAgentMappings(entries: TranscriptEntry[]): AgentMapping[] {
  const mappings: AgentMapping[] = [];

  for (const entry of entries) {
    // Only user entries carry toolUseResult
    if (entry.type !== 'user') continue;

    const result = entry.toolUseResult;
    if (!result || typeof result === 'string') continue;
    if (!('agentId' in result) || typeof result.agentId !== 'string') continue;

    const agentId = result.agentId;

    // Find the tool_use_id from the message's tool_result content block
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        mappings.push({
          agentId,
          parentToolUseID: block.tool_use_id,
        });
        break; // One mapping per entry
      }
    }
  }

  return mappings;
}

/**
 * Load and adapt a single sub-agent JSONL file, injecting parentToolUseID.
 *
 * @param filePath - Absolute path to the sub-agent .jsonl file
 * @param parentToolUseID - The parent Task's tool_use_id to inject
 * @returns Adapted entries with parentToolUseID set on each
 */
function loadSingleSubagent(
  filePath: string,
  parentToolUseID: string,
): TranscriptEntry[] {
  if (!existsSync(filePath)) return [];

  const rawEntries = parseJsonlFile(filePath);
  const adapted = adaptClaudeEntries(rawEntries as unknown as Record<string, unknown>[]);

  // Inject parentToolUseID onto every entry
  for (const entry of adapted) {
    entry.parentToolUseID = parentToolUseID;
  }

  return adapted;
}

/**
 * Recursively load sub-agent transcripts from a subagents directory.
 *
 * Scans the provided entries for Task tool_result entries with agentId,
 * loads the corresponding sub-agent JSONL files, injects parentToolUseID,
 * and recurses into any nested sub-agents (up to maxDepth).
 *
 * @param subagentsDir - Absolute path to the subagents/ directory
 * @param entries - Entries to scan for agentId references
 * @param depth - Current recursion depth (starts at 0)
 * @param maxDepth - Maximum recursion depth (default 5)
 * @returns All loaded sub-agent entries (flat array)
 */
function loadSubagentsRecursive(
  subagentsDir: string,
  entries: TranscriptEntry[],
  depth: number,
  maxDepth: number,
): TranscriptEntry[] {
  if (depth >= maxDepth) return [];

  const mappings = extractAgentMappings(entries);
  if (mappings.length === 0) return [];

  const allSubagentEntries: TranscriptEntry[] = [];

  for (const { agentId, parentToolUseID } of mappings) {
    const filePath = join(subagentsDir, `agent-${agentId}.jsonl`);
    const subEntries = loadSingleSubagent(filePath, parentToolUseID);

    if (subEntries.length === 0) continue;

    allSubagentEntries.push(...subEntries);

    // Recurse: this sub-agent may have spawned its own sub-agents
    const nestedEntries = loadSubagentsRecursive(
      subagentsDir,
      subEntries,
      depth + 1,
      maxDepth,
    );
    allSubagentEntries.push(...nestedEntries);
  }

  return allSubagentEntries;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load sub-agent transcripts and merge them into the main entry stream.
 *
 * Algorithm:
 * 1. Derive the subagents/ directory from the session path
 * 2. Scan main entries for Task tool_result entries with agentId
 * 3. For each mapping, load the sub-agent JSONL, adapt, inject parentToolUseID
 * 4. Recurse for nested sub-agents (depth limit 5)
 * 5. Strip progress entries from main that overlap with loaded sub-agents
 * 6. Return merged array: filtered main + all sub-agent entries
 *
 * @param sessionPath - Absolute path to the main session .jsonl file
 * @param mainEntries - Already-adapted entries from the main session
 * @returns Merged entries with sub-agent entries appended
 */
export function loadSubagentEntries(
  sessionPath: string,
  mainEntries: TranscriptEntry[],
): TranscriptEntry[] {
  // Derive subagents directory: /path/to/{sessionId}.jsonl → /path/to/{sessionId}/subagents/
  const sessionDir = sessionPath.replace(/\.jsonl$/, '');
  const subagentsDir = join(sessionDir, 'subagents');

  if (!existsSync(subagentsDir)) return mainEntries;

  // Load all sub-agent entries (recursively handles nesting)
  const subagentEntries = loadSubagentsRecursive(
    subagentsDir,
    mainEntries,
    0,
    5,
  );

  if (subagentEntries.length === 0) return mainEntries;

  // Collect all parentToolUseIDs that have sub-agent file data
  const loadedParentIDs = new Set<string>();
  for (const entry of subagentEntries) {
    if (entry.parentToolUseID) {
      loadedParentIDs.add(entry.parentToolUseID);
    }
  }

  // Strip progress entries from main that overlap with loaded sub-agents.
  // Progress entries are identified by type === 'progress' AND having a
  // parentToolUseID that matches a loaded sub-agent's parentToolUseID.
  const filteredMain = mainEntries.filter((entry) => {
    if (entry.type !== 'progress') return true;
    if (!entry.parentToolUseID) return true;
    return !loadedParentIDs.has(entry.parentToolUseID);
  });

  return [...filteredMain, ...subagentEntries];
}
