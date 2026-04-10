/**
 * Blocks Entry With Registry — wrapper that gets registry from context
 *
 * Wraps BlocksEntry to get the registry from BlocksToolRegistryContext
 * instead of requiring it as a prop. This is the component used by
 * BlocksTranscriptRenderer, EntryRenderer, and ToolBlockRenderer (for
 * rendering Task children recursively).
 *
 * When Icons render mode is active, consecutive tool_use blocks after text
 * blocks are grouped and rendered inline (as icon pills) within the
 * preceding text block's container. Task/Agent tools are exempt — they
 * always render as standalone blocks.
 *
 * @module webview/blocks/BlocksEntryWithRegistry
 */

import { memo, useMemo } from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import type { AnchorPoint, RichBlock } from './types.js';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';
import { normalizeToRichBlocks } from './normalize.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import { BlocksBlockRenderer } from './BlocksBlockRenderer.js';
import { MessageActions } from '../components/MessageActions.js';
import { CopyButton } from '../components/CopyButton.js';
import { serializeAssistantMessage, serializeUserMessage } from '../utils/copy-markdown.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { getToolRenderCategory } from './tool-definitions.js';

/** True when any block in the list contains displayable text. */
function hasTextBlock(blocks: RichBlock[]): boolean {
  return blocks.some(b => b.type === 'text');
}

interface BlocksEntryWithRegistryProps {
  entry: TranscriptEntry;
  /** Optional pre-normalized blocks, used when transcript renderer merges entries */
  blocksOverride?: RichBlock[];
  /** Fork target assistant message ID (for fork/rewind buttons) */
  forkTargetId?: string;
  /** True when this is the last entry in the transcript */
  isLastEntry?: boolean;
}

export const BlocksEntryWithRegistry = memo(function BlocksEntryWithRegistry({
  entry,
  blocksOverride,
  forkTargetId,
  isLastEntry = false,
}: BlocksEntryWithRegistryProps): React.JSX.Element | null {
  const registry = useBlocksToolRegistry();
  const { renderMode, markdownSkin } = usePreferences();

  // Normalize entry to rich blocks
  const blocks = useMemo(
    () => blocksOverride ?? normalizeToRichBlocks(entry),
    [blocksOverride, entry],
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
  const skinClass = role === 'assistant' && markdownSkin !== 'crispy' ? ` skin-${markdownSkin}` : '';

  // Fork/rewind only on root-level user messages (no parentToolUseId, actual user type)
  const showActions = !parentToolUseId && role === 'user' && entry.type === 'user' && forkTargetId !== undefined;
  // Copy overlay on root-level assistant messages with text (user copy lives in MessageActions)
  const showCopy = !parentToolUseId && role === 'assistant' && hasTextBlock(blocks);
  // Index of the last text block — copy overlay anchors to it so it doesn't occlude tool icons
  const lastTextIdx = showCopy ? blocks.reduce((acc, b, idx) => b.type === 'text' ? idx : acc, -1) : -1;
  const copyOverlay = showCopy ? (
    <div className="crispy-copy-overlay">
      <CopyButton
        getText={() => serializeAssistantMessage(blocks)}
        title="Copy response"
      />
    </div>
  ) : null;
  // Copy getText for user messages — passed into MessageActions
  const userCopyGetText = !parentToolUseId && role === 'user' && hasTextBlock(blocks)
    ? () => serializeUserMessage(blocks)
    : undefined;

  // When Icons mode is active and we're on the main thread, group tool_use blocks
  // that follow text blocks to render them inline.
  const isMainThread = anchor.type === 'main-thread';
  const useInline = renderMode === 'icons' && isMainThread;

  // Detect inline-only entries: all blocks are inline-category tool_use.
  // These render as <span> so they can flow inline with preceding text.
  const isInlineOnly = useInline
    && blocks.length > 0
    && blocks.every(b => b.type === 'tool_use' && getToolRenderCategory(b.name) === 'inline');

  if (isInlineOnly) {
    return (
      <span
        className={`message ${role}${skinClass} message--inline-only`}
        data-uuid={entry.uuid}
      >
        <span className="crispy-inline-icons">
          {blocks.map(block => {
            const toolBlock = block as RichBlock & { type: 'tool_use' };
            return (
              <span key={toolBlock.id} data-run-id={toolBlock.id}>
                <ToolBlockRenderer
                  block={toolBlock}
                  anchor={anchor}
                  registry={registry}
                  siblingCount={siblingCount}
                />
              </span>
            );
          })}
        </span>
      </span>
    );
  }

  return (
    <div
      className={`message ${role}${skinClass}`}
      data-uuid={entry.uuid}
    >
      {useInline
        ? renderWithInlineGrouping(blocks, anchor, registry, siblingCount, isLastEntry, copyOverlay)
        : blocks.map((block, i) => {
          const autoCollapse = block.type === 'thinking'
            ? !isLastEntry || blocks.slice(i + 1).some(b =>
                b.type === 'text' || b.type === 'tool_use' || b.type === 'image')
            : undefined;

          if (block.type === 'tool_use') {
            return (
              <div key={`tool-${block.id}`} {...(!parentToolUseId ? { 'data-run-id': block.id } : undefined)}>
                <ToolBlockRenderer
                  block={block}
                  anchor={anchor}
                  registry={registry}
                  siblingCount={siblingCount}
                />
              </div>
            );
          }

          // Wrap the last text block with the copy overlay — hover on text reveals the button
          if (i === lastTextIdx) {
            return (
              <div key={`block-${block.context.entryUuid}-${i}`} className="crispy-copy-anchor">
                <BlocksBlockRenderer block={block} autoCollapse={autoCollapse} />
                {copyOverlay}
              </div>
            );
          }

          return (
            <BlocksBlockRenderer
              key={`block-${block.context.entryUuid}-${i}`}
              block={block}
              autoCollapse={autoCollapse}
            />
          );
        })
      }
      {showActions && <MessageActions targetAssistantId={forkTargetId || null} copygetText={userCopyGetText} />}
    </div>
  );
},
(prev, next) =>
  prev.entry === next.entry &&
  prev.blocksOverride === next.blocksOverride &&
  prev.forkTargetId === next.forkTargetId &&
  prev.isLastEntry === next.isLastEntry,
);

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
  copyOverlay: React.JSX.Element | null,
): React.JSX.Element[] {
  const elements: React.JSX.Element[] = [];
  const lastTextIdx = copyOverlay ? blocks.reduce((acc, b, idx) => b.type === 'text' ? idx : acc, -1) : -1;
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];

    if (block.type === 'tool_use') {
      const category = getToolRenderCategory(block.name);

      // Non-inline tools (block, bash) always render standalone
      if (category !== 'inline') {
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

      // Collect consecutive standalone inline tools into one row
      const inlineRun: (RichBlock & { type: 'tool_use' })[] = [block as RichBlock & { type: 'tool_use' }];
      let k = i + 1;
      while (k < blocks.length && blocks[k].type === 'tool_use') {
        const next = blocks[k] as RichBlock & { type: 'tool_use' };
        if (getToolRenderCategory(next.name) !== 'inline') break;
        inlineRun.push(next);
        k++;
      }

      elements.push(
        <span key={`inline-run-${block.id}`} className="crispy-inline-icons">
          {inlineRun.map(tb => (
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
      );
      i = k;
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
      if (getToolRenderCategory(toolBlock.name) !== 'inline') break;
      inlineTools.push(toolBlock);
      j++;
    }

    if (block.type === 'text' && inlineTools.length > 0) {
      const trailingInlineIcons = (
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
      );

      // Render text block with inline tool icons appended
      const isLastText = i === lastTextIdx;
      const wrapClass = isLastText ? 'crispy-blocks-text-with-inline crispy-copy-anchor' : 'crispy-blocks-text-with-inline';
      elements.push(
        <div key={`block-${block.context.entryUuid}-${i}`} className={wrapClass}>
          <BlocksBlockRenderer
            block={block}
            autoCollapse={autoCollapse}
            trailingInlineContent={trailingInlineIcons}
          />
          {isLastText && copyOverlay}
        </div>
      );
      i = j;
    } else {
      // Regular non-text block or text without following tools
      if (i === lastTextIdx) {
        elements.push(
          <div key={`block-${block.context.entryUuid}-${i}`} className="crispy-copy-anchor">
            <BlocksBlockRenderer block={block} autoCollapse={autoCollapse} />
            {copyOverlay}
          </div>
        );
      } else {
        elements.push(
          <BlocksBlockRenderer
            key={`block-${block.context.entryUuid}-${i}`}
            block={block}
            autoCollapse={autoCollapse}
          />
        );
      }
      i++;
    }
  }

  return elements;
}
