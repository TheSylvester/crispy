/**
 * Entry Coalescing — display-time transformation for transcript entries
 *
 * Converts `TranscriptEntry[]` into `DisplayEntry[]` by grouping consecutive
 * coalesceable tool-only entries into activity groups with verb-specific
 * summaries.
 *
 * Pure transformation — no mutations, no side effects.
 *
 * @module webview/utils/coalesce-entries
 */

import type { TranscriptEntry, ToolUseBlock } from '../../core/transcript.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolActivity } from '../tool-registry.js';

// ============================================================================
// Types
// ============================================================================

export interface VerbBucket {
  activity: ToolActivity;
  count: number;
  toolIds: string[];
  errorCount: number;
  /** Unique tool names in first-occurrence order (for icon display) */
  toolNames: string[];
}

export type DisplayEntry =
  | { kind: 'entry'; entry: TranscriptEntry }
  | { kind: 'activity-group'; toolIds: string[]; verbs: VerbBucket[]; entries: TranscriptEntry[]; hasRunning: boolean; textSnippets: string[] };

// ============================================================================
// Safe Tools Definition
// ============================================================================

const SAFE_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'TodoWrite', 'Skill',
]);

const SAFE_MCP_PATTERNS = ['read', 'get', 'list', 'search', 'fetch'];

function isSafeTool(name: string): boolean {
  if (SAFE_TOOLS.has(name)) return true;
  if (name.startsWith('mcp__')) {
    const lower = name.toLowerCase();
    return SAFE_MCP_PATTERNS.some(p => lower.includes(p));
  }
  return false;
}

// ============================================================================
// Helper Functions
// ============================================================================

// ============================================================================
// Trivial Text Detection
// ============================================================================

const TRIVIAL_TEXT_MAX_CHARS = 200;
const SUBSTANTIAL_PATTERNS = /^#{1,6}\s|^```|^\s*[-*]\s.*\n\s*[-*]\s/m;

/** Check if text is trivial (short, no markdown structure) */
function isTrivialText(text: string): boolean {
  if (text.length > TRIVIAL_TEXT_MAX_CHARS) return false;
  if (SUBSTANTIAL_PATTERNS.test(text)) return false;
  return true;
}

/**
 * Check if an assistant entry has a coalesceable shape:
 * - Must have at least one tool_use block
 * - May contain tool_result blocks (OK)
 * - May contain thinking blocks (ignored for coalescing)
 * - May contain trivial text (absorbed into group)
 * - May NOT contain substantial text or image blocks
 */
function hasCoalesceableShape(entry: TranscriptEntry): boolean {
  if (entry.type !== 'assistant') return false;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;

  let hasToolUse = false;
  for (const b of content) {
    if (b.type === 'tool_use') { hasToolUse = true; }
    else if (b.type === 'tool_result') { /* OK */ }
    else if (b.type === 'thinking') { /* OK */ }
    else if (b.type === 'text') { if (!isTrivialText(b.text)) return false; }
    else { return false; } // image or unknown — not coalesceable
  }
  return hasToolUse;
}

/** Extract tool_use blocks from an entry */
function getToolUseBlocks(entry: TranscriptEntry): ToolUseBlock[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

/** Check if a single tool_use block is coalesceable */
function isCoalesceableToolBlock(name: string, toolId: string, registry: ToolRegistry): boolean {
  const toolEntry = registry.getToolEntry(toolId);
  if (!toolEntry) return false;

  // Safe tools: coalesceable in any status (including running)
  if (isSafeTool(name)) return true;

  // Bash: only coalesceable when completed successfully
  if (name === 'Bash') return toolEntry.status === 'complete';

  return false;
}

/** Check if ALL tool_use blocks in an entry are coalesceable */
function isCoalesceableEntry(entry: TranscriptEntry, registry: ToolRegistry): boolean {
  if (!hasCoalesceableShape(entry)) return false;
  const tools = getToolUseBlocks(entry);
  if (tools.length === 0) return false;
  return tools.every(t => isCoalesceableToolBlock(t.name, t.id, registry));
}

// ============================================================================
// Main Coalescing Function
// ============================================================================

export function coalesceEntries(
  entries: TranscriptEntry[],
  registry: ToolRegistry,
): DisplayEntry[] {
  const result: DisplayEntry[] = [];
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];

    // --- Try activity group coalescing ---
    if (isCoalesceableEntry(entry, registry)) {
      const group: TranscriptEntry[] = [entry];
      let j = i + 1;
      while (j < entries.length && isCoalesceableEntry(entries[j], registry)) {
        group.push(entries[j]);
        j++;
      }

      // Build verb buckets ordered by first occurrence
      const toolIds: string[] = [];
      const verbMap = new Map<ToolActivity, VerbBucket>();
      const verbOrder: ToolActivity[] = [];
      let hasRunning = false;
      const textSnippets: string[] = [];

      for (const e of group) {
        // Collect trivial text snippets from this entry
        const content = e.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'text' && b.text.trim()) {
              textSnippets.push(b.text.trim());
            }
          }
        }

        // Process tool_use blocks
        for (const t of getToolUseBlocks(e)) {
          const toolEntry = registry.getToolEntry(t.id);
          if (!toolEntry) continue;
          toolIds.push(t.id);

          const activity = toolEntry.activity;
          let vb = verbMap.get(activity);
          if (!vb) {
            vb = { activity, count: 0, toolIds: [], errorCount: 0, toolNames: [] };
            verbMap.set(activity, vb);
            verbOrder.push(activity);
          }
          vb.count++;
          vb.toolIds.push(t.id);
          if (!vb.toolNames.includes(toolEntry.name)) {
            vb.toolNames.push(toolEntry.name);
          }
          if (toolEntry.status === 'error') vb.errorCount++;
          if (toolEntry.status === 'running') hasRunning = true;
        }
      }

      const verbs = verbOrder.map(a => verbMap.get(a)!);
      result.push({ kind: 'activity-group', toolIds, verbs, entries: group, hasRunning, textSnippets });
      i = j;
      continue;
    }

    // --- Passthrough ---
    result.push({ kind: 'entry', entry });
    i++;
  }

  return result;
}
