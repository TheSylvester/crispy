/**
 * Tool Panel Card — registry-driven dispatch for the tool panel
 *
 * Like `ToolCard` but uses `resolvePanelRenderer` to prefer panel-optimized
 * renderers over inline renderers.
 *
 * Centralizes the `data-tool-id` attribute that usePanelFLIP needs for FLIP
 * animations — individual panel renderers don't need to add it.
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
  return (
    <div data-tool-id={toolId}>
      <Renderer toolId={toolId} />
    </div>
  );
}
