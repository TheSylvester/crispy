/**
 * codex-jsonl-adapter.ts
 *
 * Pure functions to adapt Codex JSONL envelope records into universal
 * TranscriptEntry[]. This is the JSONL counterpart to codex-entry-adapter.ts
 * (which adapts RPC ThreadItems).
 *
 * Responsibilities:
 * - Two-pass conversion: index outputs, then emit entries
 * - Map response_item subtypes to TranscriptEntry with proper tool pairing
 * - Parse function_call arguments (JSON string inside JSON)
 * - Parse function_call_output headers (exit code, output body)
 * - Handle both exec_command (v0.92+) and shell_command (v0.89) formats
 * - Use envelope timestamps (real time) instead of load-time timestamps
 *
 * Does NOT:
 * - Perform I/O (pure functions only)
 * - Handle event_msg records (skipped — duplicates response_item data)
 * - Generate streaming deltas
 */

import type {
  TranscriptEntry,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../../transcript.js';
import type { CodexJsonlEnvelope } from './codex-jsonl-reader.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Convert an array of Codex JSONL envelope records into TranscriptEntry[].
 *
 * Two-pass algorithm:
 * 1. **Index pass:** Collect function_call_output and custom_tool_call_output
 *    records into a Map<call_id, record> for O(1) lookup during pairing.
 * 2. **Emit pass:** Iterate records in order, producing TranscriptEntry[].
 *    Tool calls look up their paired output from the index; outputs are
 *    consumed by their calls and not emitted separately.
 *
 * Skipped record types:
 * - event_msg/* — duplicates response_item data
 * - session_meta — extracts cwd, not emitted
 * - turn_context — tracks cwd/model, not emitted
 * - response_item/message (role=developer) — system context
 * - response_item/function_call_output — consumed by function_call
 * - response_item/custom_tool_call_output — consumed by custom_tool_call
 * - response_item/ghost_snapshot — git snapshots
 * - response_item/compaction — context compaction
 *
 * @param records - Parsed JSONL envelopes in file order
 * @param sessionId - Session UUID for entry metadata
 * @returns Adapted TranscriptEntry[] in chronological order
 */
export function adaptCodexJsonlRecords(
  records: CodexJsonlEnvelope[],
  sessionId: string,
): TranscriptEntry[] {
  // Pass 1: Index output records by call_id for O(1) lookup
  const outputIndex = new Map<string, CodexJsonlEnvelope>();
  for (const record of records) {
    if (record.type !== 'response_item') continue;
    const subtype = record.payload.type as string;
    if (
      subtype === 'function_call_output' ||
      subtype === 'custom_tool_call_output'
    ) {
      const callId = record.payload.call_id as string;
      if (callId) outputIndex.set(callId, record);
    }
  }

  // Pass 2: Emit entries
  const entries: TranscriptEntry[] = [];
  let currentCwd: string | undefined;
  let currentModel: string | undefined;
  let entryCounter = 0;

  for (const record of records) {
    switch (record.type) {
      case 'session_meta': {
        currentCwd = record.payload.cwd as string | undefined;
        break; // Not emitted
      }

      case 'turn_context': {
        const payload = record.payload;
        if (payload.cwd) currentCwd = payload.cwd as string;
        if (payload.model) currentModel = payload.model as string;
        break; // Not emitted
      }

      case 'event_msg':
        break; // Skip entirely — duplicates response_item data

      case 'response_item': {
        const emitted = emitResponseItem(
          record,
          sessionId,
          outputIndex,
          currentCwd,
          currentModel,
          entryCounter,
        );
        for (const entry of emitted) {
          entries.push(entry);
        }
        entryCounter += emitted.length;
        break;
      }
    }
  }

  return entries;
}

// ============================================================================
// Response Item Dispatcher
// ============================================================================

function emitResponseItem(
  record: CodexJsonlEnvelope,
  sessionId: string,
  outputIndex: Map<string, CodexJsonlEnvelope>,
  cwd: string | undefined,
  model: string | undefined,
  counter: number,
): TranscriptEntry[] {
  const payload = record.payload;
  const subtype = payload.type as string;
  const timestamp = record.timestamp;

  const base = {
    sessionId,
    vendor: 'codex' as const,
    timestamp,
    cwd,
  };

  switch (subtype) {
    case 'message':
      return emitMessage(payload, base, model, counter);

    case 'reasoning':
      return emitReasoning(payload, base, counter);

    case 'function_call':
      return emitFunctionCall(payload, base, outputIndex, counter);

    case 'custom_tool_call':
      return emitCustomToolCall(payload, base, outputIndex, counter);

    case 'web_search_call':
      return emitWebSearchCall(payload, base, counter);

    // Consumed by their paired call — skip
    case 'function_call_output':
    case 'custom_tool_call_output':
      // Check if this is an orphan (no matching call)
      return emitOrphanedOutput(payload, subtype, base, outputIndex, counter);

    // Skipped record types
    case 'ghost_snapshot':
    case 'compaction':
    case 'other':
      return [];

    default:
      return [];
  }
}

// ============================================================================
// Message Emitter
// ============================================================================

function emitMessage(
  payload: Record<string, unknown>,
  base: BaseFields,
  model: string | undefined,
  counter: number,
): TranscriptEntry[] {
  const role = payload.role as string;
  const contentItems = payload.content as ContentItem[];
  const phase = payload.phase as string | undefined;

  // Skip developer messages (system/permissions context)
  if (role === 'developer') return [];

  if (role === 'user') {
    return [
      {
        type: 'user',
        uuid: generateId(base.sessionId, counter),
        ...base,
        message: {
          role: 'user',
          content: adaptContentItems(contentItems),
        },
      },
    ];
  }

  if (role === 'assistant') {
    return [
      {
        type: 'assistant',
        uuid: generateId(base.sessionId, counter),
        ...base,
        message: {
          role: 'assistant',
          content: adaptContentItems(contentItems),
          model,
        },
        metadata: phase ? { phase } : undefined,
      },
    ];
  }

  // Unknown role — skip
  return [];
}

// ============================================================================
// Reasoning Emitter
// ============================================================================

function emitReasoning(
  payload: Record<string, unknown>,
  base: BaseFields,
  counter: number,
): TranscriptEntry[] {
  const summaryItems = payload.summary as SummaryItem[] | null;

  const thinkingBlocks: ThinkingBlock[] = [];

  // Extract summary text blocks
  if (Array.isArray(summaryItems)) {
    for (const item of summaryItems) {
      if (item.type === 'summary_text' && item.text) {
        thinkingBlocks.push({
          type: 'thinking',
          thinking: item.text,
          metadata: { isSummary: true },
        });
      }
    }
  }

  // If no thinking blocks were produced, skip entirely
  if (thinkingBlocks.length === 0) return [];

  return [
    {
      type: 'assistant',
      uuid: generateId(base.sessionId, counter),
      ...base,
      message: {
        role: 'assistant',
        content: thinkingBlocks,
      },
    },
  ];
}

// ============================================================================
// Function Call Emitter (exec_command / shell_command)
// ============================================================================

function emitFunctionCall(
  payload: Record<string, unknown>,
  base: BaseFields,
  outputIndex: Map<string, CodexJsonlEnvelope>,
  _counter: number,
): TranscriptEntry[] {
  const callId = payload.call_id as string;
  const name = payload.name as string;
  const rawArgs = payload.arguments;

  // Parse arguments — may be a JSON string or an already-parsed object
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = { raw: rawArgs };
    }
  } else if (typeof rawArgs === 'object' && rawArgs !== null) {
    args = rawArgs as Record<string, unknown>;
  }

  // Map Codex function names to universal tool names + inputs
  const { toolName, toolInput, metadata } = mapFunctionCall(name, args);

  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: callId,
    name: toolName,
    input: toolInput,
  };

  const assistantEntry: TranscriptEntry = {
    type: 'assistant',
    uuid: callId,
    ...base,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
    metadata,
  };

  const entries: TranscriptEntry[] = [assistantEntry];

  // Look up paired output
  const outputRecord = outputIndex.get(callId);
  if (outputRecord) {
    const outputPayload = outputRecord.payload;
    const rawOutput = outputPayload.output as string;
    const { exitCode, body } = parseExecOutputHeader(rawOutput);
    const isError = exitCode !== 0;

    const toolResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: callId,
      content: body,
      is_error: isError,
    };

    const resultEntry: TranscriptEntry = {
      type: 'result',
      uuid: `${callId}-result`,
      parentUuid: callId,
      sessionId: base.sessionId,
      vendor: base.vendor,
      timestamp: outputRecord.timestamp,
      cwd: base.cwd,
      message: {
        role: 'tool',
        content: [toolResult],
      },
      toolUseResult: {
        output: body,
        exitCode,
      },
    };

    entries.push(resultEntry);

    // Mark as consumed so it won't be emitted as orphan
    outputIndex.delete(callId);
  }

  return entries;
}

// ============================================================================
// Custom Tool Call Emitter (apply_patch, etc.)
// ============================================================================

function emitCustomToolCall(
  payload: Record<string, unknown>,
  base: BaseFields,
  outputIndex: Map<string, CodexJsonlEnvelope>,
  _counter: number,
): TranscriptEntry[] {
  const callId = payload.call_id as string;
  const name = payload.name as string;
  const input = payload.input as string;

  // For apply_patch, parse into per-file Edit/Write entries
  if (name === 'apply_patch') {
    return emitApplyPatch(callId, input, base, outputIndex);
  }

  // Other custom tools: pass through
  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: callId,
    name,
    input: { raw: input },
  };

  const assistantEntry: TranscriptEntry = {
    type: 'assistant',
    uuid: callId,
    ...base,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
  };

  const entries: TranscriptEntry[] = [assistantEntry];

  // Look up paired output
  const outputRecord = outputIndex.get(callId);
  if (outputRecord) {
    entries.push(
      buildCustomToolResult(callId, callId, outputRecord, base),
    );
    outputIndex.delete(callId);
  }

  return entries;
}

/**
 * Emit per-file Edit/Write entries from a parsed apply_patch call.
 *
 * For updates → Edit with { file_path, old_string, new_string }
 * For adds    → Write with { file_path, content }
 * For deletes → Edit with { file_path } + metadata { isDelete: true }
 *
 * Falls back to generic { patch: input } if the parser returns nothing.
 */
function emitApplyPatch(
  callId: string,
  input: string,
  base: BaseFields,
  outputIndex: Map<string, CodexJsonlEnvelope>,
): TranscriptEntry[] {
  const changes = parseCodexPatch(input);

  // Fallback: malformed patch — preserve old behavior
  if (changes.length === 0) {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: callId,
      name: 'Edit',
      input: { patch: input },
    };

    const entries: TranscriptEntry[] = [
      {
        type: 'assistant',
        uuid: callId,
        ...base,
        message: { role: 'assistant', content: [toolUse] },
      },
    ];

    const outputRecord = outputIndex.get(callId);
    if (outputRecord) {
      entries.push(buildCustomToolResult(callId, callId, outputRecord, base));
      outputIndex.delete(callId);
    }

    return entries;
  }

  const entries: TranscriptEntry[] = [];

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const entryId = i === 0 ? callId : `${callId}-file-${i}`;

    let toolName: string;
    let toolInput: Record<string, unknown>;
    let metadata: Record<string, unknown> | undefined;

    switch (change.kind) {
      case 'add':
        toolName = 'Write';
        toolInput = { file_path: change.path, content: change.newString };
        break;
      case 'delete':
        toolName = 'Edit';
        toolInput = { file_path: change.path };
        metadata = { isDelete: true };
        break;
      case 'update':
      default:
        toolName = 'Edit';
        toolInput = {
          file_path: change.path,
          old_string: change.oldString,
          new_string: change.newString,
        };
        break;
    }

    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: entryId,
      name: toolName,
      input: toolInput,
    };

    entries.push({
      type: 'assistant',
      uuid: entryId,
      ...base,
      message: { role: 'assistant', content: [toolUse] },
      metadata,
    });
  }

  // Attach the result to the last file entry (or first if single-file)
  const outputRecord = outputIndex.get(callId);
  if (outputRecord) {
    const lastEntry = entries[entries.length - 1];
    entries.push(
      buildCustomToolResult(lastEntry.uuid ?? callId, callId, outputRecord, base),
    );
    outputIndex.delete(callId);
  }

  return entries;
}

/**
 * Build a tool_result entry from a custom_tool_call_output record.
 */
function buildCustomToolResult(
  parentUuid: string,
  callId: string,
  outputRecord: CodexJsonlEnvelope,
  base: BaseFields,
): TranscriptEntry {
  const rawOutput = outputRecord.payload.output as string;

  let content: string;
  let isError = false;
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    content = (parsed.output as string) ?? rawOutput;
    if (parsed.success === false || parsed.error) {
      isError = true;
    }
  } catch {
    content = rawOutput;
  }

  const toolResult: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: callId,
    content,
    is_error: isError,
  };

  return {
    type: 'result',
    uuid: `${parentUuid}-result`,
    parentUuid,
    sessionId: base.sessionId,
    vendor: base.vendor,
    timestamp: outputRecord.timestamp,
    cwd: base.cwd,
    message: {
      role: 'tool',
      content: [toolResult],
    },
  };
}

// ============================================================================
// Web Search Call Emitter
// ============================================================================

function emitWebSearchCall(
  payload: Record<string, unknown>,
  base: BaseFields,
  counter: number,
): TranscriptEntry[] {
  const action = payload.action as Record<string, unknown> | undefined;
  const query = action?.query as string | undefined;
  const status = payload.status as string | undefined;
  const id = generateId(base.sessionId, counter);

  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id,
    name: 'WebSearch',
    input: { query: query ?? '' },
  };

  const entries: TranscriptEntry[] = [
    {
      type: 'assistant',
      uuid: id,
      ...base,
      message: {
        role: 'assistant',
        content: [toolUse],
      },
      metadata: { action },
    },
  ];

  // Emit a synthetic result so the tool registry doesn't show perpetual "running"
  if (status === 'completed') {
    const toolResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: id,
      content: '',
      is_error: false,
    };

    entries.push({
      type: 'result',
      uuid: `${id}-result`,
      parentUuid: id,
      ...base,
      message: {
        role: 'tool',
        content: [toolResult],
      },
    });
  }

  return entries;
}

// ============================================================================
// Orphaned Output Emitter
// ============================================================================

/**
 * Emit orphaned outputs — output records whose matching call was not found.
 * Only emits if the call_id is still in the outputIndex (not consumed).
 */
function emitOrphanedOutput(
  payload: Record<string, unknown>,
  subtype: string,
  base: BaseFields,
  outputIndex: Map<string, CodexJsonlEnvelope>,
  _counter: number,
): TranscriptEntry[] {
  const callId = payload.call_id as string;
  if (!callId) return [];

  // If still in the index, it hasn't been consumed by a call — it's orphaned
  if (!outputIndex.has(callId)) return [];

  const rawOutput = payload.output as string;
  let content: string;
  let isError = false;

  if (subtype === 'function_call_output') {
    const parsed = parseExecOutputHeader(rawOutput);
    content = parsed.body;
    isError = parsed.exitCode !== 0;
  } else {
    content = rawOutput;
  }

  const toolResult: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: callId,
    content,
    is_error: isError,
  };

  // Remove from index so we don't emit it again
  outputIndex.delete(callId);

  return [
    {
      type: 'result',
      uuid: `${callId}-result`,
      parentUuid: callId,
      ...base,
      message: {
        role: 'tool',
        content: [toolResult],
      },
    },
  ];
}

// ============================================================================
// Helpers — Content Block Adaptation
// ============================================================================

/** Codex JSONL content item (input_text, output_text, input_image). */
interface ContentItem {
  type: string;
  text?: string;
  image_url?: string;
}

/** Codex JSONL reasoning summary item. */
interface SummaryItem {
  type: string;
  text?: string;
}

/** Base fields shared by all emitted entries. */
interface BaseFields {
  sessionId: string;
  vendor: 'codex';
  timestamp: string;
  cwd?: string;
}

/**
 * Convert Codex content items (input_text/output_text/input_image)
 * to universal ContentBlock[].
 */
function adaptContentItems(
  items: ContentItem[] | null | undefined,
): import('../../transcript.js').ContentBlock[] {
  if (!Array.isArray(items)) return [];

  const blocks: import('../../transcript.js').ContentBlock[] = [];

  for (const item of items) {
    switch (item.type) {
      case 'input_text':
      case 'output_text':
        if (item.text) {
          blocks.push({ type: 'text', text: item.text });
        }
        break;

      case 'input_image':
        if (item.image_url) {
          // Parse data URIs to extract media_type and raw base64 separately,
          // avoiding double-wrapping when ImageRenderer prepends its own prefix
          const dataUriMatch = item.image_url.match(
            /^data:(image\/[^;]+);base64,(.+)$/s,
          );
          if (dataUriMatch) {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: dataUriMatch[1],
                data: dataUriMatch[2],
              },
            });
          } else {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                data: item.image_url,
              },
            });
          }
        }
        break;
    }
  }

  return blocks;
}

// ============================================================================
// Helpers — Function Call Mapping
// ============================================================================

/** Result of mapping a Codex function call to universal tool name/input. */
interface MappedFunctionCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Map Codex function names to universal tool names and inputs.
 *
 * Handles both current (v0.92+) and legacy (v0.89) formats:
 * - exec_command: { cmd, workdir? } → Bash { command }
 * - shell_command: { command, workdir? } → Bash { command }
 * - view_image: { path } → Read { file_path }
 * - update_plan: { plan } → TodoWrite { todos }
 * - write_stdin: { session_id, content } → Bash (informational)
 */
function mapFunctionCall(
  name: string,
  args: Record<string, unknown>,
): MappedFunctionCall {
  switch (name) {
    case 'exec_command':
      return {
        toolName: 'Bash',
        toolInput: { command: (args.cmd as string) ?? '' },
      };

    case 'shell_command':
      return {
        toolName: 'Bash',
        toolInput: { command: (args.command as string) ?? '' },
      };

    case 'view_image':
      return {
        toolName: 'Read',
        toolInput: { file_path: (args.path as string) ?? '' },
        metadata: { isImageView: true },
      };

    case 'update_plan': {
      const plan =
        (args.plan as Array<{ step: string; status: string }>) ?? [];
      return {
        toolName: 'TodoWrite',
        toolInput: {
          todos: plan.map((item) => ({
            content: item.step,
            status: item.status,
            activeForm: item.step,
          })),
        },
      };
    }

    case 'write_stdin':
      return {
        toolName: 'Bash',
        toolInput: {
          command: `(write_stdin to session ${(args.session_id as string) ?? 'unknown'})`,
        },
      };

    default:
      // Unknown function — pass through with original name
      return { toolName: name, toolInput: args };
  }
}

// ============================================================================
// Helpers — Output Header Parsing
// ============================================================================

/**
 * Parse the structured header in function_call_output.output strings.
 *
 * Supports two formats:
 *
 * Current (v0.92+, exec_command):
 *   Chunk ID: <hex>
 *   Wall time: <float> seconds
 *   Process exited with code <int>
 *   Original token count: <int>
 *   Output:
 *   <actual output>
 *
 * Legacy (v0.89, shell_command):
 *   Exit code: <int>
 *   Wall time: <int> seconds
 *   Output:
 *   <actual output>
 *
 * @returns { exitCode, body } where body is the output after the header
 */
function parseExecOutputHeader(output: string): {
  exitCode: number;
  body: string;
} {
  if (!output) return { exitCode: 0, body: '' };

  // Current format: "Process exited with code <int>"
  const currentMatch = output.match(/Process exited with code (\d+)/);
  if (currentMatch) {
    const exitCode = parseInt(currentMatch[1], 10);
    const outputIdx = output.indexOf('Output:\n');
    const body =
      outputIdx >= 0 ? output.slice(outputIdx + 'Output:\n'.length) : '';
    return { exitCode, body };
  }

  // Legacy format: "Exit code: <int>"
  const legacyMatch = output.match(/Exit code: (\d+)/);
  if (legacyMatch) {
    const exitCode = parseInt(legacyMatch[1], 10);
    const outputIdx = output.indexOf('Output:\n');
    const body =
      outputIdx >= 0 ? output.slice(outputIdx + 'Output:\n'.length) : '';
    return { exitCode, body };
  }

  // Unrecognized format — return as-is with success exit code
  return { exitCode: 0, body: output };
}

// ============================================================================
// Helpers — Codex Patch Parser
// ============================================================================

/** A single file operation extracted from a Codex apply_patch payload. */
interface PatchFileChange {
  path: string;
  kind: 'update' | 'add' | 'delete';
  oldString: string;
  newString: string;
}

/**
 * Parse a Codex apply_patch input string into per-file changes.
 *
 * Patch format:
 *   *** Begin Patch
 *   *** Update File: /path/to/file.ts
 *   @@ .. @@
 *   -old line
 *   +new line
 *    context line
 *   *** Add File: /path/to/new-file.ts
 *   +new file content
 *   *** Delete File: /path/to/old.ts
 *   *** End Patch
 *
 * For update blocks, hunk lines prefixed with '-' go into oldString,
 * '+' into newString, and unprefixed context lines go into both.
 */
function parseCodexPatch(input: string): PatchFileChange[] {
  if (!input) return [];

  const lines = input.split('\n');
  const changes: PatchFileChange[] = [];

  let currentPath: string | undefined;
  let currentKind: 'update' | 'add' | 'delete' | undefined;
  let oldLines: string[] = [];
  let newLines: string[] = [];

  function flushCurrent() {
    if (currentPath && currentKind) {
      changes.push({
        path: currentPath,
        kind: currentKind,
        oldString: oldLines.join('\n'),
        newString: newLines.join('\n'),
      });
    }
    currentPath = undefined;
    currentKind = undefined;
    oldLines = [];
    newLines = [];
  }

  for (const line of lines) {
    // File header lines
    const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)$/);
    if (updateMatch) {
      flushCurrent();
      currentPath = updateMatch[1].trim();
      currentKind = 'update';
      continue;
    }

    const addMatch = line.match(/^\*\*\* Add File:\s*(.+)$/);
    if (addMatch) {
      flushCurrent();
      currentPath = addMatch[1].trim();
      currentKind = 'add';
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File:\s*(.+)$/);
    if (deleteMatch) {
      flushCurrent();
      currentPath = deleteMatch[1].trim();
      currentKind = 'delete';
      continue;
    }

    // Skip patch boundary markers and hunk headers
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      continue;
    }
    if (line.startsWith('@@')) {
      continue;
    }

    // Inside a file block — collect diff lines
    if (!currentPath) continue;

    if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      // Context line — belongs to both sides
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
    // Lines not starting with -/+/space inside a block are ignored
  }

  flushCurrent();

  return changes;
}

// ============================================================================
// Helpers — ID Generation
// ============================================================================

/**
 * Generate a deterministic entry ID for records that lack a natural key.
 * Tool calls use their call_id; messages and reasoning use this counter.
 */
function generateId(sessionId: string, counter: number): string {
  return `codex-jsonl-${sessionId.slice(0, 8)}-${counter}`;
}
