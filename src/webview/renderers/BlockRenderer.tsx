/**
 * Block Renderer — YAML-default dispatch for individual content blocks
 *
 * The glue between the discrimination tree (block-registry) and the
 * rendering layer. Every block resolves to a role-prefixed string key
 * via resolveBlockType(), then looks up a custom renderer in the
 * rendererMap with cascading fallback.
 *
 * The rendererMap starts EMPTY — every block renders as a YAML dump of
 * that individual block. Custom renderers are registered later by setting
 * keys in the map:
 *
 *   rendererMap.set('assistant:text', TextBlockRenderer);
 *   rendererMap.set('assistant:tool:Bash', BashToolCard);
 *
 * Cascading fallback: the full role-prefixed key is tried first, then
 * the role prefix is stripped for a role-agnostic match. This lets you
 * register at either specificity:
 *
 *   rendererMap.set('assistant:text', MarkdownRenderer);  // only assistant
 *   rendererMap.set('text', PlainTextRenderer);           // all roles
 *
 * Unreplaced keys stay YAML. You can ship partial rich rendering — some
 * blocks are fancy, others are still raw data. The discrimination tree
 * doesn't change. The pipeline doesn't change. Only the leaf renderers
 * evolve.
 *
 * The data-block-type attribute on the wrapper div enables CSS targeting
 * for specific block types ([data-block-type$=":thinking"]) even before
 * building custom renderers.
 *
 * @module webview/renderers/BlockRenderer
 */

import { resolveBlockType } from './block-registry.js';
import { YamlDump } from './YamlDump.js';
import type { ContentBlock } from '../../core/transcript.js';

/**
 * Renderer override map — starts EMPTY.
 *
 * TODO: When the first custom renderer is built, replace this mutable Map
 * with a static initializer populated inline:
 *
 *   const rendererMap = new Map<string, React.ComponentType<{ block: ContentBlock }>>([
 *     ['assistant:text', TextBlockRenderer],
 *     ['assistant:thinking', ThinkingBlock],
 *     ['assistant:tool:Bash', BashToolCard],
 *     ['assistant:tool:Edit', EditToolCard],
 *   ]);
 *
 * A static initializer is deterministic, survives HMR, and avoids
 * side-effect-based registration scattered across import sites.
 * See walkthrough Section 5 discussion for rationale.
 */
export const rendererMap = new Map<string, React.ComponentType<{ block: ContentBlock }>>();

/**
 * Renders a single content block.
 *
 * - Resolves the block to a role-prefixed string key via the discrimination tree
 * - Looks up a custom renderer with cascading fallback (specific → general)
 * - Falls through to YAML dump if no custom renderer is registered
 */
export function BlockRenderer({ block, role }: { block: ContentBlock; role: string }): React.JSX.Element {
  const key = resolveBlockType(block, role);

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
