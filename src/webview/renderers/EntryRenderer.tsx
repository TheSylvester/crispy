/**
 * Entry Renderer — pure mode-dispatch router
 *
 * Dispatches to YAML, Compact, or Rich renderer based on the active
 * render mode. Contains no rendering logic of its own.
 *
 * Ported from Leto's `webview-next/renderer/entry.ts` render dispatch.
 *
 * @module EntryRenderer
 */

import type { TranscriptEntry } from "../../core/transcript.js";
import type { RenderMode } from "../types.js";
import { YamlEntry } from "./YamlEntry.js";
import { CompactEntry } from "./CompactEntry.js";
import { RichEntry } from "./RichEntry.js";

// ============================================================================
// Entry Renderer — mode dispatch
// ============================================================================

interface EntryRendererProps {
  entry: TranscriptEntry;
  mode?: RenderMode;
}

/**
 * Top-level entry renderer. Dispatches to the active render mode.
 * Default is YAML mode for the development phase.
 */
export function EntryRenderer({
  entry,
  mode = "yaml",
}: EntryRendererProps): React.JSX.Element | null {
  switch (mode) {
    case "yaml":
      return <YamlEntry entry={entry} />;
    case "compact":
      return <CompactEntry entry={entry} />;
    case "rich":
      return <RichEntry entry={entry} />;
  }
}
