/**
 * Rich Entry Renderer — normalize → dispatch → render pipeline
 *
 * Projects every entry into ContentBlock[] via normalizeToBlocks(), then
 * renders each block through BlockRenderer. The discrimination tree
 * (block-registry) resolves block types; the renderer map (BlockRenderer)
 * dispatches to custom renderers or falls through to YAML-default.
 *
 * The critical Leto design is preserved: tool_result blocks return null
 * from BlockRenderer, and CSS `.message:empty` hides the wrapper div
 * when all children are null.
 *
 * @module webview/renderers/RichEntry
 */

import { useMemo } from 'react';
import { normalizeToBlocks } from '../utils/normalize-blocks.js';
import { BlockRenderer } from './BlockRenderer.js';
import { MessageActions } from '../components/MessageActions.js';
import { PerfProfiler } from '../perf/index.js';
import type { TranscriptEntry, ToolUseBlock } from '../../core/transcript.js';

interface RichEntryProps {
  entry: TranscriptEntry;
  /** Pre-resolved fork target — passed from EntryRenderer to avoid ForkContext subscription. */
  forkTargetId?: string;
}

/**
 * Rich mode entry renderer.
 *
 * No switch, no branching, no stubs. The normalize-dispatch-render
 * pipeline handles everything.
 *
 * Does NOT subscribe to ForkContext — receives forkTargetId as a prop
 * so React.memo on the parent EntryRenderer can bail out effectively.
 * MessageActions (the only ForkContext consumer) subscribes on its own.
 */
export function RichEntry({ entry, forkTargetId }: RichEntryProps): React.JSX.Element | null {
  const blocks = useMemo(() => normalizeToBlocks(entry), [entry]);
  if (blocks.length === 0) return null;

  // Summary entries render with 'system' styling (matching old explicit behavior).
  // Other entries derive role from the message or fall back to entry type.
  const role = entry.type === 'summary' ? 'system' : (entry.message?.role ?? entry.type);

  return (
    <PerfProfiler id="RichEntry">
      <div className={`message ${role}`} data-uuid={entry.uuid}>
        {blocks.map((block, i) => (
          <BlockRenderer
            key={block.type === 'tool_use' ? (block as ToolUseBlock).id : `${entry.uuid}-${i}`}
            block={block}
            role={role}
          />
        ))}
        {forkTargetId !== undefined && <MessageActions targetAssistantId={forkTargetId || null} />}
      </div>
    </PerfProfiler>
  );
}
