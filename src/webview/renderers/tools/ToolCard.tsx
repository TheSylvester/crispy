/**
 * Tool Card — registry-driven dispatch component
 *
 * Looks up a tool entry from the registry, resolves the correct renderer
 * via resolveToolKey, and renders it. Used by TaskTool for nested children
 * and available for any registry-driven rendering path.
 *
 * @module webview/renderers/tools/ToolCard
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { resolveToolKey } from '../block-registry.js';
import { toolRendererMap, GenericTool } from './index.js';

export function ToolCard({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const key = resolveToolKey(entry.name);  // NOT `tool:${entry.name}` — MCP tools need resolution
  const Renderer = toolRendererMap.get(key) ?? GenericTool;
  return <Renderer toolId={toolId} />;
}
