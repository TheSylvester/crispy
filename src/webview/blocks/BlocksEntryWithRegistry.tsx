/**
 * Blocks Entry With Registry — wrapper that gets registry from context
 *
 * Wraps BlocksEntry to get the registry from BlocksToolRegistryContext
 * instead of requiring it as a prop. This is the component used by
 * BlocksTranscriptRenderer, EntryRenderer, and ToolBlockRenderer (for
 * rendering Task children recursively).
 *
 * When inline tool mode is active, consecutive tool_use blocks after text
 * blocks are grouped and rendered inline (as icon pills) within the
 * preceding text block's container. Task/Agent tools are exempt — they
 * always render as standalone blocks.
 *
 * @module webview/blocks/BlocksEntryWithRegistry
 */

import { useMemo } from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import type { AnchorPoint, RichBlock } from './types.js';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';
import { normalizeToRichBlocks } from './normalize.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import { BlocksBlockRenderer } from './BlocksBlockRenderer.js';
import { MessageActions } from '../components/MessageActions.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { getToolDefinition } from './tool-definitions.js';

/** Agent-category tools that are exempt from inline mode (they have children). */
const AGENT_TOOLS = new Set(['Task', 'Agent']);

interface BlocksEntryWithRegistryProps {
  entry: TranscriptEntry;
  /** Fork target assistant message ID (for fork/rewind buttons) */
  forkTargetId?: string;
  /** True when this is the last entry in the transcript */
  isLastEntry?: boolean;
}

export function BlocksEntryWithRegistry({
  entry,
  forkTargetId,
  isLastEntry = false,
}: BlocksEntryWithRegistryProps): React.JSX.Element | null {
  const registry = useBlocksToolRegistry();
  const { inlineToolMode } = usePreferences();

  // Normalize entry to rich blocks
  const blocks = useMemo(
    () => normalizeToRichBlocks(entry),
    [entry],
  );

  // Skip empty entries
  if (blocks.length === 0) return null;

  // Count tool_use blocks for view selection
  const siblingCount = blocks.filter((b) => b.type === 'tool_use').length;

  // Derive anchor from structural context.
  const parentToolUseId = blocks[0]?.context.parentToolUseId;

  // Nested entries use task-tool anchor so views render
  // in compact mode for completed tools, expanded for running.
  const anchor: AnchorPoint = parentToolUseId
    ? { type: 'task-tool', parentId: parentToolUseId }
    : { type: 'main-thread' };

  // Get role for message class
  const role = blocks[0]?.context.role ?? 'unknown';

  // Fork/rewind only on root-level user messages (no parentToolUseId)
  const showActions = !parentToolUseId && role === 'user' && forkTargetId !== undefined;

  // When inline mode is on and we're on the main thread, group tool_use blocks
  // that follow text blocks to render them inline.
  const isMainThread = anchor.type === 'main-thread';
  const useInline = inlineToolMode && isMainThread;

  return (
    <div
      className={`message ${role}`}
      data-uuid={entry.uuid}
    >
      {useInline
        ? renderWithInlineGrouping(blocks, anchor, registry, siblingCount, isLastEntry)
        : blocks.map((block, i) => {
          const autoCollapse = block.type === 'thinking'
            ? !isLastEntry || blocks.slice(i + 1).some(b =>
                b.type === 'text' || b.type === 'tool_use' || b.type === 'image')
            : undefined;

          return block.type === 'tool_use' ? (
            <div key={`tool-${block.id}`} {...(!parentToolUseId ? { 'data-run-id': block.id } : undefined)}>
              <ToolBlockRenderer
                block={block}
                anchor={anchor}
                registry={registry}
                siblingCount={siblingCount}
              />
            </div>
          ) : (
            <BlocksBlockRenderer
              key={`block-${block.context.entryUuid}-${i}`}
              block={block}
              autoCollapse={autoCollapse}
            />
          );
        })
      }
      {showActions && <MessageActions targetAssistantId={forkTargetId || null} />}
    </div>
  );
}

/**
 * Render blocks with inline grouping: consecutive tool_use blocks after a
 * text block are collected into an inline icon strip appended to the text
 * block's container. Task/Agent tools are always standalone.
 */
function renderWithInlineGrouping(
  blocks: RichBlock[],
  anchor: AnchorPoint,
  registry: ReturnType<typeof useBlocksToolRegistry>,
  siblingCount: number,
  isLastEntry: boolean,
): React.JSX.Element[] {
  const elements: React.JSX.Element[] = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];

    if (block.type === 'tool_use') {
      // Agent tools always render standalone
      if (AGENT_TOOLS.has(block.name)) {
        elements.push(
          <div key={`tool-${block.id}`} data-run-id={block.id}>
            <ToolBlockRenderer
              block={block}
              anchor={anchor}
              registry={registry}
              siblingCount={siblingCount}
            />
          </div>
        );
        i++;
        continue;
      }

      // Check if this tool has an inline view registered
      const def = getToolDefinition(block.name);
      if (!def?.views.inline) {
        // No inline view — render as standalone compact
        elements.push(
          <div key={`tool-${block.id}`} data-run-id={block.id}>
            <ToolBlockRenderer
              block={block}
              anchor={anchor}
              registry={registry}
              siblingCount={siblingCount}
            />
          </div>
        );
        i++;
        continue;
      }

      // Standalone inline tool (no preceding text) — render as standalone
      elements.push(
        <div key={`tool-${block.id}`} data-run-id={block.id}>
          <ToolBlockRenderer
            block={block}
            anchor={anchor}
            registry={registry}
            siblingCount={siblingCount}
          />
        </div>
      );
      i++;
      continue;
    }

    // Non-tool block (text, thinking, image, etc.)
    const autoCollapse = block.type === 'thinking'
      ? !isLastEntry || blocks.slice(i + 1).some(b =>
          b.type === 'text' || b.type === 'tool_use' || b.type === 'image')
      : undefined;

    // Look ahead: collect consecutive inline-eligible tool_use blocks
    const inlineTools: (RichBlock & { type: 'tool_use' })[] = [];
    let j = i + 1;
    while (j < blocks.length && blocks[j].type === 'tool_use') {
      const toolBlock = blocks[j] as RichBlock & { type: 'tool_use' };
      if (AGENT_TOOLS.has(toolBlock.name)) break;
      const def = getToolDefinition(toolBlock.name);
      if (!def?.views.inline) break;
      inlineTools.push(toolBlock);
      j++;
    }

    if (block.type === 'text' && inlineTools.length > 0) {
      // Render text block with inline tool icons appended
      elements.push(
        <div key={`block-${block.context.entryUuid}-${i}`} className="crispy-blocks-text-with-inline">
          <BlocksBlockRenderer block={block} autoCollapse={autoCollapse} />
          <span className="crispy-inline-icons">
            {inlineTools.map(tb => (
              <span key={tb.id} data-run-id={tb.id}>
                <ToolBlockRenderer
                  block={tb}
                  anchor={anchor}
                  registry={registry}
                  siblingCount={siblingCount}
                />
              </span>
            ))}
          </span>
        </div>
      );
      i = j;
    } else {
      // Regular non-text block or text without following tools
      elements.push(
        <BlocksBlockRenderer
          key={`block-${block.context.entryUuid}-${i}`}
          block={block}
          autoCollapse={autoCollapse}
        />
      );
      i++;
    }
  }

  return elements;
}
