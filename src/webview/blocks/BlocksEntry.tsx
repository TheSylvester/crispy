/**
 * Blocks Entry — top-level component for rendering an entry in blocks mode
 *
 * Equivalent of RichEntry for the blocks rendering pipeline.
 * Takes a TranscriptEntry, normalizes to RichBlocks, and renders
 * blocks directly through the blocks pipeline.
 *
 * @module webview/blocks/BlocksEntry
 */

import { useMemo, useEffect } from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import type { AnchorPoint, RichBlock } from './types.js';
import { BlocksToolRegistry } from './blocks-tool-registry.js';
import { normalizeToRichBlocks } from './normalize.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import { BlocksBlockRenderer } from './BlocksBlockRenderer.js';
import { MessageActions } from '../components/MessageActions.js';
import { CopyButton } from '../components/CopyButton.js';
import { serializeAssistantMessage, serializeUserMessage } from '../utils/copy-markdown.js';
import { usePreferences } from '../context/PreferencesContext.js';

/** True when any block in the list contains displayable text. */
function hasTextBlock(blocks: RichBlock[]): boolean {
  return blocks.some(b => b.type === 'text');
}

interface BlocksEntryProps {
  entry: TranscriptEntry;
  /** Registry instance (shared across entries in a session) */
  registry: BlocksToolRegistry;
  /** Fork target assistant message ID (for fork/rewind buttons) */
  forkTargetId?: string;
  /** Optional depth lookup for nested entries */
  depthLookup?: (parentToolUseId: string) => number;
  /** True when this is the last entry in the transcript */
  isLastEntry?: boolean;
}

export function BlocksEntry({
  entry,
  registry,
  forkTargetId,
  depthLookup,
  isLastEntry = false,
}: BlocksEntryProps): React.JSX.Element | null {
  // Normalize entry to rich blocks
  const blocks = useMemo(
    () => normalizeToRichBlocks(entry, depthLookup),
    [entry, depthLookup],
  );

  // Register tool_use blocks and resolve tool_result blocks
  // This runs during render (silent mode) to populate registry before children render
  useEffect(() => {
    registry.silent(() => {
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          registry.register(block.id, block.name);
        } else if (block.type === 'tool_result') {
          registry.resolve(block.tool_use_id, block);
        }
      }
    });
  }, [blocks, registry]);

  // Flush any deferred notifications after render
  useEffect(() => {
    registry.flushDirty();
  });

  // Skip empty entries
  if (blocks.length === 0) return null;

  // Count tool_use blocks for view selection
  const siblingCount = blocks.filter((b) => b.type === 'tool_use').length;

  // Determine anchor point
  const anchor: AnchorPoint = { type: 'main-thread' };

  // Get role for message class
  const role = blocks[0]?.context.role ?? 'unknown';
  const { markdownSkin } = usePreferences();
  const skinClass = markdownSkin !== 'crispy' ? ` skin-${markdownSkin}` : '';

  // Show fork/rewind on user messages only (not tool_results with role='user')
  const showActions = role === 'user' && entry.type === 'user' && forkTargetId !== undefined;
  // Copy overlay on assistant messages with text (user copy lives in MessageActions)
  const showCopy = role === 'assistant' && hasTextBlock(blocks);
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
  const userCopyGetText = role === 'user' && hasTextBlock(blocks)
    ? () => serializeUserMessage(blocks)
    : undefined;

  return (
    <div className={`message ${role}${skinClass}`} data-uuid={entry.uuid}>
      {blocks.map((block, i) => {
        // Auto-collapse thinking blocks when newer substantive content follows
        const autoCollapse = block.type === 'thinking'
          ? !isLastEntry || blocks.slice(i + 1).some(b =>
              b.type === 'text' || b.type === 'tool_use' || b.type === 'image')
          : undefined;

        if (block.type === 'tool_use') {
          return (
            <div key={`tool-${block.id}`} data-run-id={block.id}>
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
      })}
      {/* Fork/rewind + copy — bottom-right of user bubble */}
      {showActions && <MessageActions targetAssistantId={forkTargetId || null} copygetText={userCopyGetText} />}
    </div>
  );
}

// ============================================================================
// Convenience Hook for Registry Instance
// ============================================================================

/**
 * Create a BlocksToolRegistry instance for use in a session.
 * Should be created once per session and passed to all BlocksEntry components.
 */
export function createBlocksToolRegistry(): BlocksToolRegistry {
  return new BlocksToolRegistry();
}
