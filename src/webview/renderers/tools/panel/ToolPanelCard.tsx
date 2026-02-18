/**
 * Tool Panel Card — registry-driven dispatch for the tool panel
 *
 * Like `ToolCard` but uses `resolvePanelRenderer` to prefer panel-optimized
 * renderers over inline renderers.
 *
 * @module webview/renderers/tools/panel/ToolPanelCard
 */

import { useToolEntry } from '../../../context/ToolRegistryContext.js';
import { resolveToolKey } from '../../block-registry.js';
import { resolvePanelRenderer } from './tool-panel-registry.js';

export function ToolPanelCard({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const key = resolveToolKey(entry.name);
  const Renderer = resolvePanelRenderer(key);
  return <Renderer toolId={toolId} />;
}
