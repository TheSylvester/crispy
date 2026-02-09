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

import { normalizeToBlocks } from '../utils/normalize-blocks.js';
import { BlockRenderer } from './BlockRenderer.js';
import type { TranscriptEntry, ToolUseBlock } from '../../core/transcript.js';

/**
 * Rich mode entry renderer.
 *
 * No switch, no branching, no stubs. The normalize-dispatch-render
 * pipeline handles everything.
 */
export function RichEntry({ entry }: { entry: TranscriptEntry }): React.JSX.Element | null {
  const blocks = normalizeToBlocks(entry);
  if (blocks.length === 0) return null;

  // Summary entries render with 'system' styling (matching old explicit behavior).
  // Other entries derive role from the message or fall back to entry type.
  const role = entry.type === 'summary' ? 'system' : (entry.message?.role ?? entry.type);

  return (
    <div className={`message ${role}`} data-uuid={entry.uuid}>
      {blocks.map((block, i) => (
        <BlockRenderer
          key={block.type === 'tool_use' ? (block as ToolUseBlock).id : `${entry.uuid}-${i}`}
          block={block}
          role={role}
        />
      ))}
    </div>
  );
}
