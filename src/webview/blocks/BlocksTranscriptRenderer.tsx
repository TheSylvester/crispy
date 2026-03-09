/**
 * Blocks Transcript Renderer — entry list component for blocks mode
 *
 * Equivalent of TranscriptEntryList in TranscriptViewer.tsx.
 * Renders entries through the blocks pipeline using BlocksEntry.
 *
 * Each entry renders its blocks directly — no run coalescing.
 * This component is intentionally simple.
 *
 * @module webview/blocks/BlocksTranscriptRenderer
 */

import type { TranscriptEntry } from '../../core/transcript.js';
import type { RichBlock } from './types.js';
import { BlocksEntryWithRegistry } from './BlocksEntryWithRegistry.js';
import { normalizeToRichBlocks } from './normalize.js';
import { getToolRenderCategory } from './tool-definitions.js';

interface BlocksTranscriptRendererProps {
  entries: TranscriptEntry[];
  forkTargets: Map<string, string>;
}

interface RenderEntry {
  key: string;
  entry: TranscriptEntry;
  blocksOverride?: RichBlock[];
}

function isRootAssistantEntry(entry: TranscriptEntry): boolean {
  return entry.message?.role === 'assistant' && !entry.parentToolUseID;
}

function isInlineOnlyAssistantEntry(blocks: RichBlock[]): boolean {
  return blocks.length > 0
    && blocks.every(block => block.type === 'tool_use')
    && blocks.every(block => getToolRenderCategory(block.name) === 'inline');
}

function canAbsorbInlineEntries(blocks: RichBlock[]): boolean {
  // Any non-empty assistant entry can absorb following inline-only entries.
  // The renderWithInlineGrouping function handles mixed blocks — text blocks
  // render normally, inline tools get grouped into icon strips.
  return blocks.length > 0;
}

function buildRenderEntries(entries: TranscriptEntry[]): RenderEntry[] {
  const normalized = entries.map(entry => ({
    entry,
    blocks: normalizeToRichBlocks(entry),
  }));

  const renderEntries: RenderEntry[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const current = normalized[i];

    if (current.blocks.length === 0) {
      renderEntries.push({
        key: current.entry.uuid ?? `entry-${i}`,
        entry: current.entry,
      });
      continue;
    }

    if (!isRootAssistantEntry(current.entry) || !canAbsorbInlineEntries(current.blocks)) {
      renderEntries.push({
        key: current.entry.uuid ?? `entry-${i}`,
        entry: current.entry,
      });
      continue;
    }

    const mergedBlocks = [...current.blocks];
    let merged = false;
    let j = i + 1;

    while (j < normalized.length) {
      const next = normalized[j];
      if (!isRootAssistantEntry(next.entry) || !isInlineOnlyAssistantEntry(next.blocks)) {
        break;
      }
      mergedBlocks.push(...next.blocks);
      merged = true;
      j++;
    }

    renderEntries.push({
      key: current.entry.uuid ?? `entry-${i}`,
      entry: current.entry,
      blocksOverride: merged ? mergedBlocks : undefined,
    });

    if (merged) {
      i = j - 1;
    }
  }

  return renderEntries;
}

export function BlocksTranscriptRenderer({
  entries,
  forkTargets,
}: BlocksTranscriptRendererProps): React.JSX.Element {
  const renderEntries = buildRenderEntries(entries);

  return (
    <>
      {renderEntries.map((renderEntry, i) => (
        <BlocksEntryWithRegistry
          key={renderEntry.key}
          entry={renderEntry.entry}
          blocksOverride={renderEntry.blocksOverride}
          forkTargetId={renderEntry.entry.uuid ? forkTargets.get(renderEntry.entry.uuid) : undefined}
          isLastEntry={i === renderEntries.length - 1}
        />
      ))}
    </>
  );
}
