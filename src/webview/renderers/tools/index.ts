/**
 * Tool Renderer Map — maps block-registry keys to React tool components
 *
 * Imported by both BlockRenderer (stream-driven) and ToolCard (registry-driven
 * nesting). GenericTool is the fallback for tools not in the map.
 *
 * @module webview/renderers/tools/index
 */

import { GenericTool } from './GenericTool.js';
import { BashTool } from './BashTool.js';
import { ReadTool } from './ReadTool.js';
import { WriteTool } from './WriteTool.js';
import { EditTool } from './EditTool.js';
import { GlobTool } from './GlobTool.js';
import { GrepTool } from './GrepTool.js';
import { TaskTool } from './TaskTool.js';
import { TodoTool } from './TodoTool.js';

export const toolRendererMap = new Map<string, React.ComponentType<{ toolId: string }>>([
  ['tool:Bash', BashTool],
  ['tool:Read', ReadTool],
  ['tool:Write', WriteTool],
  ['tool:Edit', EditTool],
  ['tool:Glob', GlobTool],
  ['tool:Grep', GrepTool],
  ['tool:Task', TaskTool],
  ['tool:TodoWrite', TodoTool],
  // Phase 2 tools added later (WebSearch, WebFetch, etc.)
]);

/** Default renderer for tools not in the map */
export { GenericTool };
