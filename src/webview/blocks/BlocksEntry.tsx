/**
 * Blocks Entry -- top-level component for rendering an entry in blocks mode
 *
 * Takes a TranscriptEntry, normalizes to RichBlocks, and renders
 * blocks directly through the blocks pipeline.
 *
 * For completed assistant turns on the main thread, ephemeral/read-only
 * tools (Read, Grep, Glob, etc.) are collapsed into a summary row via
 * CollapsedTurnSummary. Outcome tools (Bash, Edit, Write) always render
 * as individual compact rows. During streaming, all tools render normally.
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
import { CollapsedTurnSummary, isEphemeralTool } from './CollapsedTurnSummary.js';

export interface BlocksEntryProps {
  entry: TranscriptEntry;
  /** True when this assistant turn is complete (not actively streaming). */
  isTurnComplete?: boolean;
}

export function BlocksEntry({
  entry,
  isTurnComplete,
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

  // --- Collapsed turn summary for completed assistant turns ---
  // On the main thread, completed assistant entries with ephemeral tools
  // collapse those tools into a summary row. Outcome tools always show
  // as individual compact rows.
  const shouldCollapse =
    isTurnComplete &&
    role === 'assistant' &&
    anchor.type === 'main-thread' &&
    siblingCount > 0;

  // Separate tool_use blocks into ephemeral and outcome groups
  const { ephemeralBlocks, outcomeBlocks } = useMemo(() => {
    if (!shouldCollapse) {
      return { ephemeralBlocks: [], outcomeBlocks: [] };
    }
    const eph: (RichBlock & { type: 'tool_use' })[] = [];
    const out: (RichBlock & { type: 'tool_use' })[] = [];
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      if (isEphemeralTool(block.name)) {
        eph.push(block as RichBlock & { type: 'tool_use' });
      } else {
        out.push(block as RichBlock & { type: 'tool_use' });
      }
    }
    return { ephemeralBlocks: eph, outcomeBlocks: out };
  }, [shouldCollapse, blocks]);

  // When collapsing, we render blocks in a specific order:
  // 1. Non-tool blocks before the first tool_use (assistant text preamble)
  // 2. Collapsed ephemeral summary row
  // 3. Outcome tools as individual compact rows
  // 4. Non-tool blocks after tools (trailing assistant text)
  // 5. tool_result blocks (invisible, for registry pairing)
  if (shouldCollapse && ephemeralBlocks.length > 0) {
    // Split non-tool blocks into before-tools and after-tools
    const beforeToolBlocks: { block: RichBlock; index: number }[] = [];
    const afterToolBlocks: { block: RichBlock; index: number }[] = [];
    let firstToolIndex = -1;
    let lastToolIndex = -1;

    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type === 'tool_use') {
        if (firstToolIndex === -1) firstToolIndex = i;
        lastToolIndex = i;
      }
    }

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === 'tool_use' || block.type === 'tool_result') continue;
      if (firstToolIndex === -1 || i < firstToolIndex) {
        beforeToolBlocks.push({ block, index: i });
      } else if (i > lastToolIndex) {
        afterToolBlocks.push({ block, index: i });
      }
    }

    return (
      <div
        className={`message ${role}`}
        data-uuid={entry.uuid}
      >
        {/* Pre-tool text blocks (assistant preamble) */}
        {beforeToolBlocks.map(({ block, index }) => (
          <BlocksBlockRenderer
            key={`block-${block.context.entryUuid}-${index}`}
            block={block}
          />
        ))}

        {/* Collapsed ephemeral tools summary */}
        <CollapsedTurnSummary
          blocks={ephemeralBlocks}
          registry={registry}
          siblingCount={siblingCount}
          anchor={anchor}
        />

        {/* Outcome tools as individual compact rows */}
        {outcomeBlocks.map((block) => (
          <div key={`tool-${block.id}`} data-run-id={block.id}>
            <ToolBlockRenderer
              block={block}
              anchor={anchor}
              registry={registry}
              siblingCount={siblingCount}
            />
          </div>
        ))}

        {/* Post-tool text blocks (trailing assistant text) */}
        {afterToolBlocks.map(({ block, index }) => (
          <BlocksBlockRenderer
            key={`block-${block.context.entryUuid}-${index}`}
            block={block}
          />
        ))}

        {/* tool_result blocks — invisible, for registry pairing */}
        {blocks
          .filter((b): b is RichBlock & { type: 'tool_result'; tool_use_id: string } =>
            b.type === 'tool_result')
          .map((block) => (
            <ToolResultRenderer
              key={`result-${block.tool_use_id}`}
              block={block}
            />
          ))}

        {showActions && <MessageActions entryUuid={entry.uuid ?? ''} />}
      </div>
    );
  }

  // --- Default rendering (no collapse) ---
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
