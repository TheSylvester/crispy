/**
 * Block Registry — three-level discrimination tree for content blocks
 *
 * Maps each ContentBlock to a role-prefixed string key that identifies
 * its renderer. Level 1 is role (passed in), Level 2 dispatches on
 * block.type, Level 3 dispatches on block.name for tool_use blocks.
 * The key is used by BlockRenderer to look up custom renderers (or
 * fall through to YAML default).
 *
 * Every block gets a key — there are no null returns. This makes
 * tool_result blocks renderable (YAML default) and lets consumers
 * register role-specific renderers (e.g. 'assistant:text' vs 'user:text').
 *
 * Design: resolves blocks to string keys, NOT to components.
 * The renderer decides how to draw each key. This keeps the registry
 * pure and testable — no React dependency.
 *
 * @module webview/renderers/block-registry
 */

import type { ContentBlock, ToolUseBlock } from '../../core/transcript.js';

/** Known tool names → their registry keys */
const TOOL_KEY_MAP = new Map<string, string>([
  ['Bash',            'tool:Bash'],
  ['Edit',            'tool:Edit'],
  ['MultiEdit',       'tool:MultiEdit'],
  ['Read',            'tool:Read'],
  ['Write',           'tool:Write'],
  ['Glob',            'tool:Glob'],
  ['Grep',            'tool:Grep'],
  ['LS',              'tool:LS'],
  ['Task',            'tool:Task'],
  ['TaskOutput',      'tool:TaskOutput'],
  ['TaskStop',        'tool:TaskStop'],
  ['WebSearch',       'tool:WebSearch'],
  ['WebFetch',        'tool:WebFetch'],
  ['TodoWrite',       'tool:TodoWrite'],
  ['AskUserQuestion', 'tool:AskUserQuestion'],
  ['Skill',           'tool:Skill'],
  ['EnterPlanMode',   'tool:EnterPlanMode'],
  ['ExitPlanMode',    'tool:ExitPlanMode'],
  ['NotebookEdit',    'tool:NotebookEdit'],
  ['ListMcpResources','tool:ListMcpResources'],
  ['ReadMcpResource', 'tool:ReadMcpResource'],
]);

/**
 * Resolve a tool_use block's name to a registry key.
 *
 * - Known tools → 'tool:{Name}' (O(1) Map lookup)
 * - MCP tools (mcp__*) → 'tool:mcp:{server}:{action}'
 * - Unknown → 'tool:unknown'
 */
function resolveToolKey(name: string): string {
  // Defense in depth — adapter sanitizes, but guard remains for safety.
  if (typeof name !== 'string') return 'tool:unknown';

  const known = TOOL_KEY_MAP.get(name);
  if (known) return known;

  // MCP tools: mcp__serverName__actionName → tool:mcp:serverName:actionName
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    // parts[0] = 'mcp', parts[1] = server, parts[2+] = action
    const server = parts[1] || 'unknown';
    const action = parts.slice(2).join(':') || 'unknown';
    return `tool:mcp:${server}:${action}`;
  }

  return 'tool:unknown';
}

/**
 * Resolve a content block to its role-prefixed registry key.
 *
 * Every block gets a key — there are no null returns. The role prefix
 * naturally distinguishes 'assistant:text' from 'user:text', and makes
 * tool_result blocks renderable ('tool:tool_result' instead of null).
 *
 * Two O(1) Map lookups for known blocks. The only string operation
 * is the mcp__ prefix check for MCP tool_use blocks.
 */
export function resolveBlockType(block: ContentBlock, role: string): string {
  let blockKey: string;
  switch (block.type) {
    case 'text':        blockKey = 'text'; break;
    case 'thinking':    blockKey = 'thinking'; break;
    case 'image':       blockKey = 'image'; break;
    case 'tool_result': blockKey = 'tool_result'; break;
    case 'tool_use':    blockKey = resolveToolKey((block as ToolUseBlock).name); break;
    default:            blockKey = 'unknown'; break;
  }
  return `${role}:${blockKey}`;
}
