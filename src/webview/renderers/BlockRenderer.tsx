/**
 * Block Renderer — dispatch for individual content blocks
 *
 * The glue between the discrimination tree (block-registry) and the
 * rendering layer. Every block resolves to a role-prefixed string key
 * via resolveBlockType(), then looks up a custom renderer.
 *
 * Content blocks (text, thinking, image) dispatch through blockRendererMap.
 * Tool blocks dispatch through toolRendererMap with cascading fallback.
 *
 * @module webview/renderers/BlockRenderer
 */

import { resolveBlockType } from './block-registry.js';
import { YamlDump } from './YamlDump.js';
import { UserTextRenderer } from './UserTextRenderer.js';
import { AssistantTextRenderer } from './AssistantTextRenderer.js';
import { toolRendererMap, GenericTool } from './tools/index.js';
import type { ContentBlock, ToolUseBlock } from '../../core/transcript.js';

/**
 * Static renderer map — role-prefixed block key → React component.
 *
 * For content blocks (text, thinking, image). Tool blocks use toolRendererMap.
 */
export const blockRendererMap = new Map<string, React.ComponentType<{ block: ContentBlock }>>([
  ['user:text', UserTextRenderer],
  ['assistant:text', AssistantTextRenderer],
]);

/**
 * Renders a single content block.
 *
 * - Resolves the block to a role-prefixed string key via the discrimination tree
 * - tool_result → null (result teleports to ToolCard via registry)
 * - tool_use → tool-specific renderer via toolRendererMap
 * - Other blocks → blockRendererMap with cascading fallback → YAML dump
 */
export function BlockRenderer({ block, role }: { block: ContentBlock; role: string }): React.JSX.Element | null {
  const key = resolveBlockType(block, role);

  // tool_result → null (result teleports to ToolCard via registry)
  if (block.type === 'tool_result') return null;

  // tool_use → dispatch through toolRendererMap
  if (block.type === 'tool_use') {
    const toolKey = resolveBlockType(block, role);  // e.g. 'assistant:tool:Bash'
    // Cascade: full key → strip role prefix → generic fallback
    const ToolRenderer = toolRendererMap.get(toolKey)
      ?? toolRendererMap.get(toolKey.slice(toolKey.indexOf(':') + 1))  // 'tool:Bash'
      ?? GenericTool;
    return <ToolRenderer toolId={(block as ToolUseBlock).id} />;
  }

  // Content blocks: cascading fallback (role-specific → role-agnostic)
  const Custom = blockRendererMap.get(key) ?? blockRendererMap.get(key.slice(key.indexOf(':') + 1));
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
