/**
 * opencode-entry-adapter.ts
 *
 * Pure functions to adapt OpenCode message parts to Crispy TranscriptEntry.
 *
 * Responsibilities:
 * - Map all 12 OpenCode Part types to TranscriptEntry
 * - Handle tool state lifecycle (pending → running → completed → error)
 * - Normalize OpenCode tool names to Crispy PascalCase
 * - Parse subtask results
 *
 * Does NOT:
 * - Perform I/O
 * - Manage state
 * - Handle protocol transport or SSE events
 */

import type {
  TranscriptEntry,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContextUsage,
} from '../../transcript.js';
import { getContextWindowTokens } from '../../model-utils.js';
import type {
  Part,
  TextPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepFinishPart,
  RetryPart,
} from '@opencode-ai/sdk/client';

// ============================================================================
// Tool Name Normalization
// ============================================================================

/** Map OpenCode lowercase tool names → Crispy PascalCase equivalents. */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  task: 'Task',
  apply_patch: 'Edit',
};

/**
 * Normalize an OpenCode tool name to Crispy conventions.
 *
 * - Known tools → PascalCase via TOOL_NAME_MAP
 * - MCP tools (contain '/') → pass through with original name
 * - Unknown tools → pass through as-is
 */
export function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

// ============================================================================
// Main Entry Point
// ============================================================================

interface BaseFields {
  sessionId: string;
  vendor: 'opencode';
  timestamp: string;
}

/**
 * Adapt an OpenCode Part to zero or more universal TranscriptEntry objects.
 *
 * Tool parts produce TWO entries when completed/errored: an assistant entry
 * with ToolUseBlock and a result entry with ToolResultBlock. Pending/running
 * tool parts produce a single entry.
 *
 * Parts that map to channel events (compaction, retry) or are internal
 * metadata (step-start, step-finish, snapshot, patch, agent) return empty
 * arrays — the caller handles those via separate callbacks.
 */
export function adaptOpenCodePart(
  part: Part,
  sessionId: string,
): TranscriptEntry[] {
  const base: BaseFields = {
    sessionId,
    vendor: 'opencode',
    timestamp: new Date().toISOString(),
  };

  switch (part.type) {
    case 'text':
      return adaptTextPart(part, base);

    case 'reasoning':
      return adaptReasoningPart(part, base);

    case 'tool':
      return adaptToolPart(part, base);

    case 'file':
      return adaptFilePart(part, base);

    case 'subtask':
      return adaptSubtaskPart(part, base);

    case 'compaction':
    case 'step-start':
    case 'step-finish':
    case 'snapshot':
    case 'patch':
    case 'agent':
    case 'retry':
      // These map to channel events or are internal metadata — not entries.
      return [];

    default:
      return [];
  }
}

// ============================================================================
// Part Type Adapters
// ============================================================================

function adaptTextPart(part: TextPart, base: BaseFields): TranscriptEntry[] {
  // Skip ignored text parts
  if (part.ignored) {
    return [];
  }

  return [{
    type: 'assistant',
    uuid: part.id,
    ...base,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: part.text }],
    },
    metadata: {
      ...(part.synthetic && { synthetic: true }),
      ...(part.time && { time: part.time }),
      ...(part.metadata && { ...part.metadata }),
    },
  }];
}

function adaptReasoningPart(part: ReasoningPart, base: BaseFields): TranscriptEntry[] {
  const thinkingBlock: ThinkingBlock = {
    type: 'thinking',
    thinking: part.text,
  };

  return [{
    type: 'assistant',
    uuid: part.id,
    ...base,
    message: {
      role: 'assistant',
      content: [thinkingBlock],
    },
    metadata: {
      time: part.time,
      ...(part.metadata && { ...part.metadata }),
    },
  }];
}

function adaptToolPart(part: ToolPart, base: BaseFields): TranscriptEntry[] {
  const toolName = normalizeToolName(part.tool);
  const callId = part.callID;

  // Build ToolUseBlock — always present
  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: callId,
    name: toolName,
    input: part.state.input,
  };

  const assistantEntry: TranscriptEntry = {
    type: 'assistant',
    uuid: part.id,
    ...base,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
    metadata: {
      tool: part.tool,
      ...(part.metadata && { ...part.metadata }),
      ...(part.state.status === 'running' && part.state.title && { title: part.state.title }),
      ...(part.state.status === 'running' && part.state.metadata && { toolMetadata: part.state.metadata }),
    },
  };

  // For pending/running, only emit the ToolUseBlock
  if (part.state.status === 'pending' || part.state.status === 'running') {
    return [assistantEntry];
  }

  // For completed/error, also emit a result entry
  const isError = part.state.status === 'error';
  let output: string;
  const resultMetadata: Record<string, unknown> = {};
  let agentId: string | undefined;

  if (part.state.status === 'error') {
    output = part.state.error;
    if (part.state.metadata) Object.assign(resultMetadata, part.state.metadata);
    if (part.state.time) resultMetadata.time = part.state.time;
  } else {
    // completed
    output = part.state.output;
    if (part.state.title) resultMetadata.title = part.state.title;
    if (part.state.metadata) {
      Object.assign(resultMetadata, part.state.metadata);
      if (toolName === 'Task' && typeof part.state.metadata.sessionId === 'string') {
        agentId = part.state.metadata.sessionId;
      }
    }
    if (part.state.time) resultMetadata.time = part.state.time;
    if (part.state.attachments?.length) resultMetadata.attachments = part.state.attachments;
  }

  const toolResult: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: callId,
    content: output,
    is_error: isError,
  };

  const resultEntry: TranscriptEntry = {
    type: 'result',
    uuid: `${callId}-result`,
    parentUuid: part.id,
    ...base,
    message: {
      role: 'tool',
      content: [toolResult],
    },
    toolUseResult: {
      output,
      ...(agentId && { agentId }),
    },
    metadata: Object.keys(resultMetadata).length > 0 ? resultMetadata : undefined,
  };

  return [assistantEntry, resultEntry];
}

function adaptFilePart(part: FilePart, base: BaseFields): TranscriptEntry[] {
  return [{
    type: 'user',
    uuid: part.id,
    ...base,
    message: {
      role: 'user',
      content: [{ type: 'text', text: part.filename ? `[File: ${part.filename}]` : '[File attachment]' }],
    },
    metadata: {
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      ...(part.source && { source: part.source }),
    },
  }];
}

/** Subtask part → inline type since SDK exports it as an anonymous union member. */
type SubtaskPart = Extract<Part, { type: 'subtask' }>;

function adaptSubtaskPart(part: SubtaskPart, base: BaseFields): TranscriptEntry[] {
  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: part.id,
    name: 'Task',
    input: {
      prompt: part.prompt,
      description: part.description,
      subagent_type: part.agent,
    },
  };

  return [{
    type: 'assistant',
    uuid: part.id,
    ...base,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
  }];
}

// ============================================================================
// Subtask Result Parsing
// ============================================================================

/**
 * Parse a subtask (Task tool) result output to extract the task result body.
 *
 * Output format: `task_id: <child-session-id>\n\n<task_result>\n{text}\n</task_result>`
 * Returns the text between `<task_result>` tags, or the full output if tags not found.
 */
export function parseTaskResult(output: string): string {
  const match = output.match(/<task_result>\n?([\s\S]*?)\n?<\/task_result>/);
  return match ? match[1] : output;
}

/**
 * Extract the child session ID from a Task tool's completed output.
 *
 * Output format starts with `task_id: <child-session-id>\n\n`
 */
export function extractChildSessionId(output: string): string | undefined {
  const match = output.match(/^task_id:\s*(\S+)/);
  return match ? match[1] : undefined;
}

// ============================================================================
// Context Usage Extraction
// ============================================================================

/**
 * Extract context usage from a StepFinishPart.
 *
 * Returns a ContextUsage-compatible shape for the adapter to track.
 */
export function extractContextUsage(part: StepFinishPart, model?: string): ContextUsage {
  const input = part.tokens.input;
  const output = part.tokens.output;
  const cacheRead = part.tokens.cache.read;
  const cacheCreation = part.tokens.cache.write;
  const totalTokens = input + output + cacheRead + cacheCreation;
  const contextWindow = getContextWindowTokens('opencode', model);

  return {
    tokens: {
      input,
      output,
      cacheRead,
      cacheCreation,
    },
    totalTokens,
    contextWindow,
    percent: Math.min(100, Math.round((totalTokens / contextWindow) * 100)),
    totalCostUsd: part.cost,
  };
}

/**
 * Check if a RetryPart should emit an error event.
 */
export function extractRetryError(part: RetryPart): string {
  return `API retry attempt ${part.attempt}: ${part.error.data.message}`;
}

