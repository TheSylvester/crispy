/**
 * Claude Code JSONL → Universal TranscriptEntry Adapter
 *
 * Pure function that transforms a single raw Claude Code JSONL entry
 * into the universal TranscriptEntry format defined in transcript.ts.
 *
 * No I/O. No file system. No side effects.
 *
 * @module claude-entry-adapter
 */

import type {
  TranscriptEntry,
  TranscriptMessage,
  EntryType,
  ToolResult,
} from '../../transcript.js';

// ============================================================================
// Entry Adapter
// ============================================================================

/**
 * Adapt a single raw Claude JSONL entry to universal TranscriptEntry.
 *
 * Returns null for entries that should be skipped:
 * - queue-operation (internal bookkeeping)
 * - progress entries without tool content
 * - malformed entries (missing type)
 *
 * Handles both SDK snake_case and JSONL camelCase field names.
 */
export function adaptClaudeEntry(raw: Record<string, unknown>): TranscriptEntry | null {
  // Skip internal bookkeeping entries
  if (raw.type === 'queue-operation') return null;

  // Guard against malformed entries
  if (typeof raw.type !== 'string') return null;

  // ---- Progress entries (sub-agent tool messages) ----
  // Progress entries have their message nested at data.message.message.
  // We unwrap to surface the actual tool_use/tool_result content.
  if (raw.type === 'progress') {
    const data = raw.data as Record<string, unknown> | undefined;
    const innerMessage = data?.message as Record<string, unknown> | undefined;
    const actualMessage = innerMessage?.message as TranscriptMessage | undefined;

    // Only transform if there's actual message content (tool_use/tool_result)
    if (actualMessage?.content) {
      return {
        type: (innerMessage?.type as EntryType) ?? 'assistant',
        uuid: raw.uuid as string | undefined,
        parentUuid: raw.parentUuid as string | null | undefined,
        sessionId: raw.sessionId as string | undefined,
        timestamp: raw.timestamp as string | undefined,
        message: actualMessage,
        agentId: data?.agentId as string | undefined,
        parentToolUseID: raw.parentToolUseID as string | undefined,
        vendor: 'claude',
      };
    }
    // Progress entries without tool content are skipped
    return null;
  }

  // ---- Standard entries ----
  // Destructure universal fields; rest goes to metadata.
  // SDK uses snake_case (session_id, parent_tool_use_id), JSONL uses camelCase.
  // We extract both and prefer the one that's defined.
  const {
    type,
    uuid,
    parentUuid,
    sessionId,
    session_id,           // SDK snake_case variant
    timestamp,
    isSidechain,
    isMeta,
    agentId,
    cwd,
    message,
    toolUseResult,
    summary,
    leafUuid,
    customTitle,
    sourceToolAssistantUUID,  // Claude's casing → our camelCase
    parent_tool_use_id,       // SDK snake_case
    parentToolUseID,          // JSONL camelCase
    ...overflow
  } = raw;

  // Claude-only entry types not in universal EntryType:
  //   "attachment"     → pass through (renderer can handle or ignore)
  //   "custom-title"   → pass through (customTitle field carries the data)
  // Both are safe to cast — the universal type's string-based EntryType
  // is intentionally tolerant at runtime even if TS narrows it.

  // Collect overflow fields into metadata bag (avoids data loss)
  const mergedMetadata = {
    ...overflow,
    ...(parent_tool_use_id !== undefined && { parent_tool_use_id }),
  };

  return {
    type: type as EntryType,
    uuid: uuid as string | undefined,
    parentUuid: parentUuid as string | null | undefined,
    // Prefer camelCase, fall back to snake_case (SDK format)
    sessionId: (sessionId ?? session_id) as string | undefined,
    timestamp: timestamp as string | undefined,
    vendor: 'claude',

    // Message content
    message: message as TranscriptMessage | undefined,

    // Sub-agent
    isSidechain: isSidechain as boolean | undefined,
    agentId: agentId as string | undefined,
    parentToolUseID: parentToolUseID as string | undefined,

    // Working directory
    cwd: cwd as string | undefined,

    // Structured tool result
    toolUseResult: toolUseResult as ToolResult | undefined,

    // Session display
    isMeta: isMeta as boolean | undefined,
    customTitle: customTitle as string | undefined,

    // Summary entries
    summary: summary as string | undefined,
    leafUuid: leafUuid as string | undefined,

    // Tool result linking
    sourceToolAssistantUuid: sourceToolAssistantUUID as string | undefined,

    // Vendor-specific overflow
    ...(Object.keys(mergedMetadata).length > 0 && { metadata: mergedMetadata }),
  };
}

/**
 * Batch-adapt an array of raw JSONL entries, filtering out nulls.
 *
 * Convenience wrapper for loadClaudeSession-style usage:
 *   const entries = adaptClaudeEntries(rawEntries);
 */
export function adaptClaudeEntries(rawEntries: Record<string, unknown>[]): TranscriptEntry[] {
  return rawEntries
    .map(adaptClaudeEntry)
    .filter((entry): entry is TranscriptEntry => entry !== null);
}
