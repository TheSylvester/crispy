/**
 * codex-entry-adapter.ts
 *
 * Pure functions to adapt Codex v2 ThreadItem variants to Crispy TranscriptEntry.
 *
 * Responsibilities:
 * - Map all 13 ThreadItem types to TranscriptEntry
 * - Handle streaming deltas
 * - Preserve Codex-specific fields in metadata
 *
 * Does NOT:
 * - Perform I/O
 * - Manage state
 * - Handle protocol transport
 */

import type {
  TranscriptEntry,
  ContentBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../../transcript.js';
import type { ThreadItem } from './protocol/v2/ThreadItem.js';
import type { UserInput } from './protocol/v2/UserInput.js';
import type { FileUpdateChange } from './protocol/v2/FileUpdateChange.js';

// ============================================================================
// ThreadItem Adapter
// ============================================================================

/**
 * Adapt a Codex v2 ThreadItem to one or more universal TranscriptEntry objects.
 *
 * Most items produce a single entry, but tool-like items (commandExecution,
 * fileChange, mcpToolCall) produce TWO: an assistant entry with ToolUseBlock
 * and a tool_result entry with ToolResultBlock.
 */
export function adaptCodexItem(
  item: ThreadItem,
  threadId: string,
  _turnId: string,
): TranscriptEntry[] {
  const baseFields = {
    sessionId: threadId,
    vendor: 'codex' as const,
    timestamp: new Date().toISOString(),
  };

  switch (item.type) {
    case 'userMessage':
      return [adaptUserMessage(item, baseFields)];

    case 'agentMessage':
      return [adaptAgentMessage(item, baseFields)];

    case 'reasoning':
      return [adaptReasoning(item, baseFields)];

    case 'plan':
      return [adaptPlan(item, baseFields)];

    case 'commandExecution':
      return adaptCommandExecution(item, baseFields);

    case 'fileChange':
      return adaptFileChange(item, baseFields);

    case 'mcpToolCall':
      return adaptMcpToolCall(item, baseFields);

    case 'collabAgentToolCall':
      return [adaptCollabAgentToolCall(item, baseFields)];

    case 'webSearch':
      return [adaptWebSearch(item, baseFields)];

    case 'imageView':
      return [adaptImageView(item, baseFields)];

    case 'enteredReviewMode':
      return [adaptEnteredReviewMode(item, baseFields)];

    case 'exitedReviewMode':
      return [adaptExitedReviewMode(item, baseFields)];

    case 'contextCompaction':
      return [adaptContextCompaction(item, baseFields)];

    default:
      // Exhaustive check - TypeScript will error if a case is missing
      item satisfies never;
      return [];
  }
}

// ============================================================================
// Delta Streaming Adapter
// ============================================================================

/**
 * Adapt a Codex streaming delta notification to a TranscriptEntry.
 *
 * Returns null for unrecognized methods.
 */
export function adaptCodexDelta(
  method: string,
  params: Record<string, unknown>,
): TranscriptEntry | null {
  switch (method) {
    case 'item/agentMessage/delta': {
      // Assistant text streaming
      const { threadId, turnId, itemId, delta } = params as {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
      };
      return {
        type: 'stream_event',
        uuid: itemId,
        sessionId: threadId,
        vendor: 'codex',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: delta }],
        },
        metadata: { turnId, deltaType: 'agentMessage' },
      };
    }

    case 'item/reasoning/summaryTextDelta': {
      // Thinking/reasoning streaming
      const { threadId, turnId, itemId, delta, summaryIndex } = params as {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
        summaryIndex: number;
      };
      return {
        type: 'stream_event',
        uuid: itemId,
        sessionId: threadId,
        vendor: 'codex',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: delta,
              metadata: { isSummary: true, summaryIndex },
            } as ThinkingBlock,
          ],
        },
        metadata: { turnId, deltaType: 'reasoning' },
      };
    }

    default:
      return null;
  }
}

// ============================================================================
// Item Type Adapters
// ============================================================================

interface BaseFields {
  sessionId: string;
  vendor: 'codex';
  timestamp: string;
}

type UserMessageItem = Extract<ThreadItem, { type: 'userMessage' }>;
type AgentMessageItem = Extract<ThreadItem, { type: 'agentMessage' }>;
type ReasoningItem = Extract<ThreadItem, { type: 'reasoning' }>;
type PlanItem = Extract<ThreadItem, { type: 'plan' }>;
type CommandExecutionItem = Extract<ThreadItem, { type: 'commandExecution' }>;
type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>;
type McpToolCallItem = Extract<ThreadItem, { type: 'mcpToolCall' }>;
type CollabAgentToolCallItem = Extract<ThreadItem, { type: 'collabAgentToolCall' }>;
type WebSearchItem = Extract<ThreadItem, { type: 'webSearch' }>;
type ImageViewItem = Extract<ThreadItem, { type: 'imageView' }>;
type EnteredReviewModeItem = Extract<ThreadItem, { type: 'enteredReviewMode' }>;
type ExitedReviewModeItem = Extract<ThreadItem, { type: 'exitedReviewMode' }>;
type ContextCompactionItem = Extract<ThreadItem, { type: 'contextCompaction' }>;

function adaptUserMessage(item: UserMessageItem, base: BaseFields): TranscriptEntry {
  const contentBlocks = adaptUserInputs(item.content);

  return {
    type: 'user',
    uuid: item.id,
    ...base,
    message: {
      role: 'user',
      content: contentBlocks,
    },
  };
}

function adaptAgentMessage(item: AgentMessageItem, base: BaseFields): TranscriptEntry {
  return {
    type: 'assistant',
    uuid: item.id,
    ...base,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: item.text }],
    },
  };
}

function adaptReasoning(item: ReasoningItem, base: BaseFields): TranscriptEntry {
  // summary[] contains the reasoning summary text
  // content[] contains raw content (often empty)
  const thinkingBlocks: ThinkingBlock[] = item.summary.map((text) => ({
    type: 'thinking',
    thinking: text,
    metadata: { isSummary: true },
  }));

  // If we have raw content, add those as well
  for (const text of item.content) {
    thinkingBlocks.push({
      type: 'thinking',
      thinking: text,
    });
  }

  return {
    type: 'assistant',
    uuid: item.id,
    ...base,
    message: {
      role: 'assistant',
      content: thinkingBlocks.length > 0 ? thinkingBlocks : [{ type: 'text', text: '' }],
    },
  };
}

function adaptPlan(item: PlanItem, base: BaseFields): TranscriptEntry {
  return {
    type: 'assistant',
    uuid: item.id,
    ...base,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: item.text }],
    },
    metadata: { isPlan: true },
  };
}

function adaptCommandExecution(item: CommandExecutionItem, base: BaseFields): TranscriptEntry[] {
  const { id, command, cwd, status, aggregatedOutput, exitCode, durationMs, processId, commandActions } = item;

  // First entry: assistant with ToolUseBlock for Bash
  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: id,
    name: 'Bash',
    input: { command },
  };

  const assistantEntry: TranscriptEntry = {
    type: 'assistant',
    uuid: id,
    ...base,
    cwd,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
    metadata: {
      processId,
      commandActions,
      status,
    },
  };

  // Second entry: tool_result
  const isError = exitCode !== null && exitCode !== 0;
  const output = aggregatedOutput ?? '';

  const toolResult: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: id,
    content: output,
    is_error: isError,
  };

  const resultEntry: TranscriptEntry = {
    type: 'result',
    uuid: `${id}-result`,
    parentUuid: id,
    ...base,
    message: {
      role: 'tool',
      content: [toolResult],
    },
    toolUseResult: {
      output,
      exitCode: exitCode ?? 0,
    },
    metadata: {
      status,
      durationMs,
    },
  };

  return [assistantEntry, resultEntry];
}

function adaptFileChange(item: FileChangeItem, base: BaseFields): TranscriptEntry[] {
  const { id, changes, status } = item;

  // Determine tool name based on change kind
  // If all changes are 'add', it's a Write; otherwise Edit
  const toolName = determineFileToolName(changes);

  // Build input based on changes
  const input = buildFileChangeInput(changes);

  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: id,
    name: toolName,
    input,
  };

  const assistantEntry: TranscriptEntry = {
    type: 'assistant',
    uuid: id,
    ...base,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
    metadata: { status },
  };

  // Tool result
  const isError = status === 'failed' || status === 'declined';
  const resultContent = buildFileChangeResultContent(changes, status);

  const toolResult: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: id,
    content: resultContent,
    is_error: isError,
  };

  const resultEntry: TranscriptEntry = {
    type: 'result',
    uuid: `${id}-result`,
    parentUuid: id,
    ...base,
    message: {
      role: 'tool',
      content: [toolResult],
    },
    metadata: { status, changes },
  };

  return [assistantEntry, resultEntry];
}

function adaptMcpToolCall(item: McpToolCallItem, base: BaseFields): TranscriptEntry[] {
  const { id, server, tool, status, arguments: args, result, error, durationMs } = item;

  // MCP tool name format: mcp__server__tool
  const toolName = `mcp__${server}__${tool}`;

  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: id,
    name: toolName,
    input: args as Record<string, unknown>,
  };

  const assistantEntry: TranscriptEntry = {
    type: 'assistant',
    uuid: id,
    ...base,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
    metadata: { server, status },
  };

  // Tool result
  const isError = status === 'failed' || error !== null;
  let resultContent: string;

  if (error) {
    resultContent = error.message;
  } else if (result) {
    resultContent = JSON.stringify(result.content);
  } else {
    resultContent = '';
  }

  const toolResult: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: id,
    content: resultContent,
    is_error: isError,
  };

  const resultEntry: TranscriptEntry = {
    type: 'result',
    uuid: `${id}-result`,
    parentUuid: id,
    ...base,
    message: {
      role: 'tool',
      content: [toolResult],
    },
    metadata: {
      server,
      status,
      durationMs,
      structuredContent: result?.structuredContent,
    },
  };

  return [assistantEntry, resultEntry];
}

function adaptCollabAgentToolCall(item: CollabAgentToolCallItem, base: BaseFields): TranscriptEntry {
  const { id, tool, status, senderThreadId, receiverThreadIds, prompt, agentsStates } = item;

  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: id,
    name: 'Task',
    input: {
      prompt: prompt ?? '',
      tool,
    },
  };

  return {
    type: 'assistant',
    uuid: id,
    ...base,
    isSidechain: true,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
    metadata: {
      collabTool: tool,
      status,
      senderThreadId,
      receiverThreadIds,
      agentsStates,
    },
  };
}

function adaptWebSearch(item: WebSearchItem, base: BaseFields): TranscriptEntry {
  const { id, query, action } = item;

  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: id,
    name: 'WebSearch',
    input: { query },
  };

  return {
    type: 'assistant',
    uuid: id,
    ...base,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
    metadata: { action },
  };
}

function adaptImageView(item: ImageViewItem, base: BaseFields): TranscriptEntry {
  const { id, path } = item;

  const toolUse: ToolUseBlock = {
    type: 'tool_use',
    id: id,
    name: 'Read',
    input: { file_path: path },
  };

  return {
    type: 'assistant',
    uuid: id,
    ...base,
    message: {
      role: 'assistant',
      content: [toolUse],
    },
    metadata: { isImageView: true },
  };
}

function adaptEnteredReviewMode(item: EnteredReviewModeItem, base: BaseFields): TranscriptEntry {
  return {
    type: 'system',
    uuid: item.id,
    ...base,
    message: {
      role: 'system',
      content: [{ type: 'text', text: 'Entered review mode' }],
    },
    metadata: { review: item.review },
  };
}

function adaptExitedReviewMode(item: ExitedReviewModeItem, base: BaseFields): TranscriptEntry {
  return {
    type: 'system',
    uuid: item.id,
    ...base,
    message: {
      role: 'system',
      content: [{ type: 'text', text: 'Exited review mode' }],
    },
    metadata: { review: item.review },
  };
}

function adaptContextCompaction(item: ContextCompactionItem, base: BaseFields): TranscriptEntry {
  return {
    type: 'system',
    uuid: item.id,
    ...base,
    message: {
      role: 'system',
      content: [{ type: 'text', text: 'Context compacted' }],
    },
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert Codex UserInput[] to universal ContentBlock[].
 */
function adaptUserInputs(inputs: UserInput[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const input of inputs) {
    switch (input.type) {
      case 'text':
        blocks.push({ type: 'text', text: input.text });
        break;

      case 'image':
        blocks.push({
          type: 'image',
          source: {
            type: 'url',
            data: input.url,
          },
        });
        break;

      case 'localImage':
        blocks.push({
          type: 'image',
          source: {
            type: 'file',
            data: input.path,
          },
        });
        break;

      case 'skill':
        // Skill references become text blocks with metadata
        blocks.push({
          type: 'text',
          text: `[Skill: ${input.name}]`,
        });
        break;

      case 'mention':
        // Mentions become text blocks
        blocks.push({
          type: 'text',
          text: `@${input.name}`,
        });
        break;
    }
  }

  return blocks;
}

/**
 * Determine tool name based on file change kinds.
 */
function determineFileToolName(changes: FileUpdateChange[]): 'Write' | 'Edit' {
  // If all changes are 'add', it's a Write operation
  const allAdds = changes.every((c) => c.kind.type === 'add');
  return allAdds ? 'Write' : 'Edit';
}

/**
 * Build input object for file change tool use.
 */
function buildFileChangeInput(changes: FileUpdateChange[]): Record<string, unknown> {
  if (changes.length === 0) {
    return {};
  }

  // For single file changes, use simple format
  if (changes.length === 1) {
    const change = changes[0];
    return {
      file_path: change.path,
      diff: change.diff,
    };
  }

  // For multiple changes, include all paths
  return {
    files: changes.map((c) => ({
      path: c.path,
      kind: c.kind.type,
      diff: c.diff,
    })),
  };
}

/**
 * Build result content string for file changes.
 */
function buildFileChangeResultContent(changes: FileUpdateChange[], status: string): string {
  if (status === 'declined') {
    return 'File change declined by user';
  }

  if (status === 'failed') {
    return 'File change failed';
  }

  const paths = changes.map((c) => c.path).join(', ');
  return `File(s) updated: ${paths}`;
}
