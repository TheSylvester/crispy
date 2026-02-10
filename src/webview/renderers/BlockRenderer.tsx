/**
 * Block Renderer — dispatch for individual content blocks
 *
 * The glue between the discrimination tree (block-registry) and the
 * rendering layer. Every block resolves to a role-prefixed string key
 * via resolveBlockType(), then looks up a custom renderer in the
 * rendererMap with cascading fallback.
 *
 * Cascading fallback: the full role-prefixed key is tried first, then
 * the role prefix is stripped for a role-agnostic match:
 *
 *   'assistant:text' → AssistantTextRenderer  (role-specific)
 *   'text'           → PlainTextRenderer      (role-agnostic fallback)
 *
 * Unregistered keys fall through to YAML dump. You can ship partial
 * rich rendering — some blocks are fancy, others are still raw data.
 *
 * The data-block-type attribute on the wrapper div enables CSS targeting
 * for specific block types ([data-block-type$=":thinking"]) even before
 * building custom renderers.
 *
 * @module webview/renderers/BlockRenderer
 */

import { resolveBlockType } from './block-registry.js';
import { YamlDump } from './YamlDump.js';
import { UserTextRenderer } from './UserTextRenderer.js';
import { AssistantTextRenderer } from './AssistantTextRenderer.js';
import { ToolUseRenderer } from './ToolUseRenderer.js';
import type { ContentBlock } from '../../core/transcript.js';

/**
 * Static renderer map — role-prefixed block key → React component.
 *
 * To add a new renderer: import the component and add an entry here.
 * Use role-prefixed keys ('assistant:text') for role-specific renderers,
 * or bare keys ('text') for role-agnostic fallbacks.
 */
export const rendererMap = new Map<string, React.ComponentType<{ block: ContentBlock }>>([
  ['user:text', UserTextRenderer],
  ['assistant:text', AssistantTextRenderer],
]);

/**
 * Renders a single content block.
 *
 * - Resolves the block to a role-prefixed string key via the discrimination tree
 * - Looks up a custom renderer with cascading fallback (specific → general)
 * - Falls through to YAML dump if no custom renderer is registered
 */
export function BlockRenderer({ block, role }: { block: ContentBlock; role: string }): React.JSX.Element | null {
  const key = resolveBlockType(block, role);

  // tool_result → null (result teleports to ToolCard via registry)
  if (block.type === 'tool_result') return null;

  // tool_use → ToolUseRenderer (reads state from registry)
  if (block.type === 'tool_use') return <ToolUseRenderer block={block} />;

  // Cascading fallback: try role-prefixed key, then strip role for agnostic match
  const Custom = rendererMap.get(key) ?? rendererMap.get(key.slice(key.indexOf(':') + 1));
  if (Custom) return <Custom block={block} />;

  // YAML default — dump the individual block
  return (
    <div className="block-yaml-default" data-block-type={key}>
      <pre className="yaml-dump">
        <YamlDump value={block} />
      </pre>
    </div>
  );
}
