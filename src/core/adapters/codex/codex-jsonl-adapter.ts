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
  const argsStr = payload.arguments as string;

  // Parse the JSON-encoded arguments string
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsStr);
  } catch {
    args = { raw: argsStr };
  }

  // Map Codex function names to universal tool names + inputs
  const { toolName, toolInput } = mapFunctionCall(name, args);

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

  // Map custom tool names to universal equivalents
  const toolName = name === 'apply_patch' ? 'Edit' : name;
  const toolInput: Record<string, unknown> =
    name === 'apply_patch' ? { patch: input } : { raw: input };

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
  };

  const entries: TranscriptEntry[] = [assistantEntry];

  // Look up paired output
  const outputRecord = outputIndex.get(callId);
  if (outputRecord) {
    const rawOutput = outputRecord.payload.output as string;

    // custom_tool_call_output.output may be a JSON string or plain text
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
    };

    entries.push(resultEntry);

    // Mark as consumed
    outputIndex.delete(callId);
  }

  return entries;
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
  const id = generateId(base.sessionId, counter);

  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id,
    name: 'WebSearch',
    input: { query: query ?? '' },
  };

  return [
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
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              data: item.image_url,
            },
          });
        }
        break;
    }
  }

  return blocks;
}

// ============================================================================
// Helpers — Function Call Mapping
// ============================================================================

/**
 * Map Codex function names to universal tool names and inputs.
 *
 * Handles both current (v0.92+) and legacy (v0.89) formats:
 * - exec_command: { cmd, workdir? } → Bash { command }
 * - shell_command: { command, workdir? } → Bash { command }
 */
function mapFunctionCall(
  name: string,
  args: Record<string, unknown>,
): { toolName: string; toolInput: Record<string, unknown> } {
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
// Helpers — ID Generation
// ============================================================================

/**
 * Generate a deterministic entry ID for records that lack a natural key.
 * Tool calls use their call_id; messages and reasoning use this counter.
 */
function generateId(sessionId: string, counter: number): string {
  return `codex-jsonl-${sessionId.slice(0, 8)}-${counter}`;
}
