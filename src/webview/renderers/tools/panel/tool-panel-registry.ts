/**
 * Tool Panel Registry — panel-specific renderer map with inline fallback
 *
 * The tool panel has its own renderer map (`toolPanelRendererMap`) with
 * panel-optimized renderers. For tools without a dedicated panel variant,
 * falls back to the inline renderer from `toolRendererMap`.
 *
 * Both maps consume the same `ToolEntry` from the same `ToolRegistry` —
 * the panel renderers are just a different projection of the same data.
 *
 * @module webview/renderers/tools/panel/tool-panel-registry
 */

import { PanelEditTool } from './PanelEditTool.js';
import { PanelTaskTool } from './PanelTaskTool.js';
import { toolRendererMap, GenericTool } from '../index.js';

/** Panel-optimized renderers — tools with dedicated panel variants.
 *  Bash intentionally omitted — falls back to inline BashTool with ToolCardShell
 *  so it renders collapsed in the panel. */
export const toolPanelRendererMap = new Map<string, React.ComponentType<{ toolId: string }>>([
  ['tool:Edit', PanelEditTool],
  ['tool:Task', PanelTaskTool],
]);

/**
 * Resolve the best renderer for a given tool key in the panel context.
 *
 * Priority: panel renderer → inline renderer → GenericTool fallback
 */
export function resolvePanelRenderer(key: string): React.ComponentType<{ toolId: string }> {
  return toolPanelRendererMap.get(key)
    ?? toolRendererMap.get(key)
    ?? GenericTool;
}
