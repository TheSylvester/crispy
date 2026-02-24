/**
 * Blocks Entry -- top-level component for rendering an entry in blocks mode
 *
 * Takes a TranscriptEntry, normalizes to RichBlocks, and renders
 * blocks directly through the blocks pipeline.
 *
 * Gets the registry from BlocksToolRegistryContext and fork targets
 * from ForkContext -- no explicit registry or forkTargetId props needed.
 *
 * @module webview/blocks/BlocksEntry
 */

import { useMemo } from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import type { RichBlock, AnchorPoint } from './types.js';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';
import { normalizeToRichBlocks } from './normalize.js';
import { ToolBlockRenderer } from './ToolBlockRenderer.js';
import { ToolResultRenderer } from './ToolResultRenderer.js';
import { BlocksBlockRenderer } from './BlocksBlockRenderer.js';
import { MessageActions } from '../components/MessageActions.js';

export interface BlocksEntryProps {
  entry: TranscriptEntry;
}

export function BlocksEntry({
  entry,
}: BlocksEntryProps): React.JSX.Element | null {
  const registry = useBlocksToolRegistry();

  // Normalize entry to rich blocks
  const blocks = useMemo(
    () => normalizeToRichBlocks(entry),
    [entry],
  );

  // Skip empty entries
  if (blocks.length === 0) return null;

  // Tool-result-only entries: contain only tool_result blocks (no text, no
  // tool_use). These are pairing data — ToolResultRenderer reports to the
  // registry and renders null. Render them without a wrapper div.
  const hasOnlyToolResults = blocks.every((b) => b.type === 'tool_result');
  if (hasOnlyToolResults) {
    return (
      <>
        {blocks.map((block) => (
          <ToolResultRenderer
            key={`result-${(block as RichBlock & { type: 'tool_result'; tool_use_id: string }).tool_use_id}`}
            block={block as RichBlock & { type: 'tool_result'; tool_use_id: string }}
          />
        ))}
      </>
    );
  }

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
  const showActions = !parentToolUseId && role === 'user';

  // --- Render blocks ---
  return (
    <div
      className={`message ${role}`}
      data-uuid={entry.uuid}
    >
      {blocks.map((block, i) =>
        block.type === 'tool_use' ? (
          <div key={`tool-${block.id}`} {...(!parentToolUseId ? { 'data-run-id': block.id } : undefined)}>
            <ToolBlockRenderer
              block={block as RichBlock & { type: 'tool_use' }}
              anchor={anchor}
              registry={registry}
              siblingCount={siblingCount}
            />
          </div>
        ) : block.type === 'tool_result' ? (
          <ToolResultRenderer
            key={`result-${block.tool_use_id}`}
            block={block as import('./types.js').RichBlock & { type: 'tool_result'; tool_use_id: string }}
          />
        ) : (
          <BlocksBlockRenderer
            key={`block-${block.context.entryUuid}-${i}`}
            block={block}
          />
        )
      )}
      {showActions && <MessageActions entryUuid={entry.uuid ?? ''} />}
    </div>
  );
}
