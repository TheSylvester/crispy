/**
 * Blocks Transcript Renderer — entry list component for blocks mode
 *
 * Equivalent of TranscriptEntryList in TranscriptViewer.tsx.
 * Renders entries through the blocks pipeline using BlocksEntry.
 *
 * Coalescing happens inside BlocksEntry at the block level via buildRuns,
 * not at the entry level — so this component is intentionally simple.
 *
 * @module webview/blocks/BlocksTranscriptRenderer
 */

import type { TranscriptEntry } from '../../core/transcript.js';
import { BlocksEntryWithRegistry } from './BlocksEntryWithRegistry.js';

interface BlocksTranscriptRendererProps {
  entries: TranscriptEntry[];
  forkTargets: Map<string, string>;
}

export function BlocksTranscriptRenderer({
  entries,
  forkTargets,
}: BlocksTranscriptRendererProps): React.JSX.Element {
  return (
    <>
      {entries.map((entry, i) => (
        <BlocksEntryWithRegistry
          key={entry.uuid ?? `entry-${i}`}
          entry={entry}
          forkTargetId={entry.uuid ? forkTargets.get(entry.uuid) : undefined}
        />
      ))}
    </>
  );
}
