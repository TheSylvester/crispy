/**
 * Entry Renderer — pure mode-dispatch router
 *
 * Dispatches to YAML, Compact, or Blocks renderer based on the active
 * render mode. Contains no rendering logic of its own.
 *
 * @module EntryRenderer
 */

import { memo } from "react";
import type { TranscriptEntry } from "../../core/transcript.js";
import type { RenderMode } from "../types.js";
import { YamlEntry } from "./YamlEntry.js";
import { CompactEntry } from "./CompactEntry.js";
import { BlocksEntryWithRegistry } from "../blocks/BlocksEntryWithRegistry.js";

// ============================================================================
// Entry Renderer — mode dispatch (memoized)
// ============================================================================

interface EntryRendererProps {
  entry: TranscriptEntry;
  mode?: RenderMode;
  /** Pre-resolved fork target for this entry (user UUID → preceding assistant UUID). */
  forkTargetId?: string;
}

/**
 * Top-level entry renderer. Dispatches to the active render mode.
 * Default is YAML mode for the development phase.
 *
 * Wrapped in React.memo with a custom comparator — useTranscript's
 * [...prev, event.entry] spread preserves object identity for existing
 * entries, so reference equality on `entry` is sufficient to bail out.
 */
export const EntryRenderer = memo(
  function EntryRenderer({
    entry,
    mode = "yaml",
    forkTargetId,
  }: EntryRendererProps): React.JSX.Element | null {
    switch (mode) {
      case "yaml":
        return <YamlEntry entry={entry} />;
      case "compact":
        return <CompactEntry entry={entry} />;
      case "blocks":
        return <BlocksEntryWithRegistry entry={entry} forkTargetId={forkTargetId} />;
    }
  },
  (prev, next) =>
    prev.entry === next.entry &&
    prev.mode === next.mode &&
    prev.forkTargetId === next.forkTargetId
);
