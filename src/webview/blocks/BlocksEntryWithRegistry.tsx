/**
 * Blocks Entry With Registry — wrapper that gets registry from context
 *
 * Wraps BlocksEntry to get the registry from BlocksToolRegistryContext
 * instead of requiring it as a prop. This is the component used by
 * BlocksTranscriptRenderer, EntryRenderer, and ToolBlockRenderer (for
 * rendering Task children recursively).
 *
 * @module webview/blocks/BlocksEntryWithRegistry
 */

import { useMemo } from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import type { AnchorPoint } from './types.js';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';
import { normalizeToRichBlocks } from './normalize.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import { BlocksBlockRenderer } from './BlocksBlockRenderer.js';
import { MessageActions } from '../components/MessageActions.js';

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

  return (
    <div
      className={`message ${role}`}
      data-uuid={entry.uuid}
    >
      {blocks.map((block, i) => {
        // Auto-collapse thinking blocks when newer substantive content follows
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
      })}
      {showActions && <MessageActions targetAssistantId={forkTargetId || null} />}
    </div>
  );
}
