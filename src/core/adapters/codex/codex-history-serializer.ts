/**
 * codex-history-serializer.ts
 *
 * Reverse adapter: converts Crispy's universal TranscriptEntry[] into Codex's
 * ResponseItem[] for in-memory history injection via the `thread/resume` RPC.
 *
 * This is the inverse of codex-entry-adapter.ts (which converts Codex -> Crispy).
 * Used by the `hydrated` session mode for cross-vendor "continue in" flows.
 *
 * Responsibilities:
 * - Map TranscriptEntry to ResponseItem (user, assistant, tool_use, tool_result, thinking)
 * - Handle text content as string or ContentBlock[]
 * - Convert images to Codex input_image format
 * - Pair tool_use + tool_result into function_call + function_call_output
 *
 * NOTE: All tool_use entries (including Bash) are serialized as function_call
 * + function_call_output pairs. We intentionally do NOT use local_shell_call
 * because that type's output is looked up by call_id from Codex's internal
 * store, which won't have entries for cross-vendor injected history. Using
 * function_call is the self-contained format that works for history injection.
 *
 * Does NOT:
 * - Perform I/O
 * - Manage state
 * - Handle protocol transport
 */

import type { TranscriptEntry, ContentBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, ImageBlock } from '../../transcript.js';
import type { ResponseItem } from './protocol/ResponseItem.js';
import type { ContentItem } from './protocol/ContentItem.js';
import type { ReasoningItemReasoningSummary } from './protocol/ReasoningItemReasoningSummary.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Convert an array of universal TranscriptEntry objects into Codex ResponseItem[]
 * suitable for the `history` field of `thread/resume`.
 *
 * Skips entry types that have no Codex equivalent (stream_event, system,
 * progress, queue-operation, file-history-snapshot, summary).
 *
 * Tool use entries (assistant with ToolUseBlock) are paired with their
 * corresponding result entries to emit function_call + function_call_output.
 */
export function serializeToCodexHistory(entries: TranscriptEntry[]): ResponseItem[] {
  if (entries.length === 0) return [];

  const items: ResponseItem[] = [];

  // Index tool results by their tool_use_id for pairing
  const resultsByToolUseId = buildToolResultIndex(entries);
  // Track which result entries we've consumed (so we don't double-emit)
  const consumedResultUuids = new Set<string>();

  for (const entry of entries) {
    // Skip non-serializable entry types
    if (shouldSkip(entry)) continue;

    // Skip result entries — they're consumed when we process their parent tool_use
    if (entry.type === 'result') continue;

    if (entry.type === 'user') {
      const item = serializeUserEntry(entry);
      if (item) items.push(item);
      continue;
    }

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!content) continue;

      const blocks = normalizeContent(content);

      // Separate thinking blocks, tool_use blocks, and text blocks
      const thinkingBlocks = blocks.filter((b): b is ThinkingBlock => b.type === 'thinking');
      const toolUseBlocks = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      const textBlocks = blocks.filter((b) => b.type === 'text');

      // Emit thinking blocks as a single reasoning item
      if (thinkingBlocks.length > 0) {
        items.push(serializeThinkingBlocks(thinkingBlocks));
      }

      // Emit text blocks as a message item
      if (textBlocks.length > 0) {
        const textContent: ContentItem[] = textBlocks.map((b) => ({
          type: 'output_text' as const,
          text: (b as { text: string }).text,
        }));
        items.push({
          type: 'message',
          role: 'assistant',
          content: textContent,
        });
      }

      // Emit each tool_use as function_call + function_call_output
      for (const toolUse of toolUseBlocks) {
        const result = resultsByToolUseId.get(toolUse.id);
        if (result) consumedResultUuids.add(result.uuid ?? '');

        items.push(serializeFunctionCall(toolUse));
        // Emit matching function_call_output if we have a result
        if (result) {
          items.push(serializeFunctionCallOutput(toolUse.id, result));
        }
      }

      continue;
    }
  }

  return items;
}

// ============================================================================
// Internal: Entry Type Serializers
// ============================================================================

function serializeUserEntry(entry: TranscriptEntry): ResponseItem | null {
  const content = entry.message?.content;
  if (content === undefined || content === null) return null;

  const contentItems: ContentItem[] = [];

  if (typeof content === 'string') {
    if (content.length === 0) return null;
    contentItems.push({ type: 'input_text', text: content });
  } else {
    for (const block of content) {
      if (block.type === 'text') {
        contentItems.push({ type: 'input_text', text: block.text });
      } else if (block.type === 'image') {
        const imageBlock = block as ImageBlock;
        const url = buildImageUrl(imageBlock);
        if (url) {
          contentItems.push({ type: 'input_image', image_url: url });
        }
      }
      // Skip tool_use, tool_result, thinking blocks in user messages
    }
  }

  if (contentItems.length === 0) return null;

  return {
    type: 'message',
    role: 'user',
    content: contentItems,
  };
}

function serializeThinkingBlocks(blocks: ThinkingBlock[]): ResponseItem {
  const summary: ReasoningItemReasoningSummary[] = blocks.map((b) => ({
    type: 'summary_text' as const,
    text: b.thinking,
  }));

  return {
    type: 'reasoning',
    summary,
    encrypted_content: null,
  };
}

function serializeFunctionCall(toolUse: ToolUseBlock): ResponseItem {
  return {
    type: 'function_call',
    name: toolUse.name,
    arguments: JSON.stringify(toolUse.input),
    call_id: toolUse.id,
  };
}

function serializeFunctionCallOutput(
  callId: string,
  result: ToolResultEntry,
): ResponseItem {
  const content = result.entry.message?.content;
  let outputStr = '';

  if (typeof content === 'string') {
    outputStr = content;
  } else if (Array.isArray(content)) {
    const toolResultBlock = content.find(
      (b): b is ToolResultBlock => b.type === 'tool_result',
    );
    if (toolResultBlock) {
      if (typeof toolResultBlock.content === 'string') {
        outputStr = toolResultBlock.content;
      } else if (Array.isArray(toolResultBlock.content)) {
        // Flatten content blocks to text
        outputStr = toolResultBlock.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n');
      }
    }
  }

  // Also try the structured toolUseResult
  if (!outputStr && result.entry.toolUseResult) {
    const tur = result.entry.toolUseResult;
    if (typeof tur === 'string') {
      outputStr = tur;
    } else if (typeof tur === 'object' && 'output' in tur) {
      outputStr = (tur as { output: string }).output;
    }
  }

  const isError = isToolResultError(result.entry);

  return {
    type: 'function_call_output',
    call_id: callId,
    output: {
      body: outputStr,
      success: isError ? false : true,
    },
  };
}

// ============================================================================
// Internal: Helpers
// ============================================================================

interface ToolResultEntry {
  uuid: string;
  entry: TranscriptEntry;
}

/**
 * Build an index of tool_result entries keyed by their tool_use_id.
 *
 * Tool results are identified by:
 * 1. A ToolResultBlock.tool_use_id in message.content
 * 2. parentUuid pointing back to the tool_use entry
 */
function buildToolResultIndex(entries: TranscriptEntry[]): Map<string, ToolResultEntry> {
  const index = new Map<string, ToolResultEntry>();

  for (const entry of entries) {
    if (entry.type !== 'result') continue;

    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const trb = block as ToolResultBlock;
          index.set(trb.tool_use_id, { uuid: entry.uuid ?? '', entry });
        }
      }
    }

    // Fallback: use parentUuid as the tool_use_id
    if (entry.parentUuid && !index.has(entry.parentUuid)) {
      index.set(entry.parentUuid, { uuid: entry.uuid ?? '', entry });
    }
  }

  return index;
}

function shouldSkip(entry: TranscriptEntry): boolean {
  switch (entry.type) {
    case 'stream_event':
    case 'system':
    case 'progress':
    case 'queue-operation':
    case 'file-history-snapshot':
    case 'summary':
      return true;
    default:
      return false;
  }
}

/**
 * Normalize message content to a ContentBlock array.
 * Wraps string content in a text block.
 */
function normalizeContent(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  return content;
}

/**
 * Build a data URL from an ImageBlock source.
 */
function buildImageUrl(block: ImageBlock): string | null {
  const src = block.source;
  if (!src) return null;

  if (src.type === 'base64' && src.media_type && src.data) {
    return `data:${src.media_type};base64,${src.data}`;
  }

  if (src.type === 'url' && src.data) {
    return src.data;
  }

  if (src.type === 'file' && src.data) {
    // Local file path — not directly representable as URL, use as-is
    return src.data;
  }

  return null;
}

function isToolResultError(entry: TranscriptEntry): boolean {
  const content = entry.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_result' && (block as ToolResultBlock).is_error) {
        return true;
      }
    }
  }
  return false;
}
