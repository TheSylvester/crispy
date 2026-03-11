/**
 * Tool Definitions — single source of truth for tool rendering behavior
 *
 * Consolidates tool rendering registrations:
 * - toolRendererMap
 * - toolPanelRendererMap
 * - TOOL_KEY_MAP
 *
 * Each tool has one ToolDefinition with views for compact and expanded modes.
 *
 * @module webview/blocks/tool-definitions
 */

import type { ReactNode } from 'react';
import type { ToolDefinition, ToolViewProps, RichBlock } from './types.js';

// Lazy-loaded view imports to avoid circular dependencies
// Views are imported and assigned at runtime by the view modules
const viewRegistry: Map<string, {
  compact: (props: ToolViewProps) => ReactNode;
  condensed?: (props: ToolViewProps) => ReactNode;
  expanded: (props: ToolViewProps) => ReactNode;
  inline?: (props: ToolViewProps) => ReactNode;
}> = new Map();

/**
 * Register views for a tool at runtime.
 * Called by view modules to inject their implementations.
 */
export function registerToolViews(
  name: string,
  views: {
    compact: (props: ToolViewProps) => ReactNode;
    condensed?: (props: ToolViewProps) => ReactNode;
    expanded: (props: ToolViewProps) => ReactNode;
    inline?: (props: ToolViewProps) => ReactNode;
  },
): void {
  viewRegistry.set(name, views);
}

// ============================================================================
// Tool Definitions — static metadata + dynamic view lookup
// ============================================================================

/** How a tool renders in Icon mode: inline pill, block dot-line, or simplified bash line. */
export type RenderCategory = 'inline' | 'block' | 'bash';

interface ToolDefinitionData {
  icon: string;
  color: string;
  activity: { verb: string; pastVerb: string };
  inspectorDefault: 'expanded' | 'compact';
  /** How this tool renders in Icon mode. Default: 'inline' (non-destructive icon pill). */
  renderCategory?: RenderCategory;
}

/** Shared metadata for recall tool entries (canonical + backward-compat alias). */
const RECALL_TOOL_DATA: ToolDefinitionData = {
  icon: '\uD83E\uDDE0',
  color: '#bd93f9',
  activity: { verb: 'Recalling', pastVerb: 'Recalled' },
  inspectorDefault: 'compact',
  renderCategory: 'block',
};

/**
 * Static metadata for all known tools.
 * Views are registered separately via registerToolViews().
 *
 * Icons defined per tool below.
 */
const TOOL_DATA: Record<string, ToolDefinitionData> = {
  // Core file operations
  Bash: {
    icon: '\uD83D\uDCBB',
    color: '#ffb86c',
    activity: { verb: 'Running', pastVerb: 'Ran' },
    inspectorDefault: 'expanded',
    renderCategory: 'bash',
  },
  Read: {
    icon: '\uD83D\uDCC4',
    color: '#8be9fd',
    activity: { verb: 'Reading', pastVerb: 'Read' },
    inspectorDefault: 'compact',
  },
  Write: {
    icon: '\u270E',
    color: '#50fa7b',
    activity: { verb: 'Writing', pastVerb: 'Wrote' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },
  Edit: {
    icon: '\uD83D\uDCDD',
    color: '#ff5555',
    activity: { verb: 'Editing', pastVerb: 'Edited' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },
  MultiEdit: {
    icon: '\uD83D\uDCDD',
    color: '#ff5555',
    activity: { verb: 'Editing', pastVerb: 'Edited' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },
  NotebookEdit: {
    icon: '\uD83D\uDCD3',
    color: '#50fa7b',
    activity: { verb: 'Editing notebook', pastVerb: 'Edited notebook' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },

  // Search tools
  Glob: {
    icon: '\uD83D\uDCC2',
    color: '#ff79c6',
    activity: { verb: 'Searching', pastVerb: 'Found' },
    inspectorDefault: 'compact',
  },
  Grep: {
    icon: '\uD83D\uDD0D',
    color: '#7dcfff',
    activity: { verb: 'Searching', pastVerb: 'Searched' },
    inspectorDefault: 'compact',
  },
  LS: {
    icon: '\uD83D\uDD0D',
    color: '#7dcfff',
    activity: { verb: 'Listing', pastVerb: 'Listed' },
    inspectorDefault: 'compact',
  },

  // Web tools
  WebSearch: {
    icon: '\uD83C\uDF10',
    color: '#bd93f9',
    activity: { verb: 'Searching', pastVerb: 'Searched' },
    inspectorDefault: 'compact',
  },
  WebFetch: {
    icon: '\uD83C\uDF0E',
    color: '#bd93f9',
    activity: { verb: 'Fetching', pastVerb: 'Fetched' },
    inspectorDefault: 'compact',
  },

  // Agent tools
  Task: {
    icon: '\uD83E\uDD16',
    color: '#e0e0e0',
    activity: { verb: 'Running agent', pastVerb: 'Agent completed' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },
  Agent: {
    icon: '\uD83E\uDD16',
    color: '#e0e0e0',
    activity: { verb: 'Running agent', pastVerb: 'Agent completed' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },
  TaskOutput: {
    icon: '\uD83E\uDD16',
    color: '#e0e0e0',
    activity: { verb: 'Getting output', pastVerb: 'Got output' },
    inspectorDefault: 'expanded',
  },
  KillShell: {
    icon: '\uD83E\uDD16',
    color: '#e0e0e0',
    activity: { verb: 'Killing shell', pastVerb: 'Killed shell' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },
  TaskStop: {
    icon: '\uD83D\uDED1',
    color: '#ff5555',
    activity: { verb: 'Stopping task', pastVerb: 'Stopped task' },
    inspectorDefault: 'compact',
    renderCategory: 'block',
  },

  // Utility tools
  TodoWrite: {
    icon: '\u2611\uFE0F',
    color: '#bd93f9',
    activity: { verb: 'Updating todos', pastVerb: 'Updated todos' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },
  Skill: {
    icon: '\u2728',
    color: '#bd93f9',
    activity: { verb: 'Running skill', pastVerb: 'Ran skill' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },

  // User interaction tools
  AskUserQuestion: {
    icon: '\u2753',
    color: '#8be9fd',
    activity: { verb: 'Asking', pastVerb: 'Asked' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },
  ExitPlanMode: {
    icon: '\uD83D\uDCCB',
    color: '#8be9fd',
    activity: { verb: 'Exiting plan mode', pastVerb: 'Exited plan mode' },
    inspectorDefault: 'expanded',
    renderCategory: 'block',
  },
  EnterPlanMode: {
    icon: '\uD83D\uDCCB',
    color: '#8be9fd',
    activity: { verb: 'Entering plan mode', pastVerb: 'Entered plan mode' },
    inspectorDefault: 'expanded',
  },
  EnterWorktree: {
    icon: '\uD83C\uDF33',
    color: '#50fa7b',
    activity: { verb: 'Creating worktree', pastVerb: 'Created worktree' },
    inspectorDefault: 'compact',
  },

  // MCP tools
  ReadMcpResource: {
    icon: '\uD83D\uDCC4',
    color: '#8be9fd',
    activity: { verb: 'Reading MCP', pastVerb: 'Read MCP' },
    inspectorDefault: 'compact',
    renderCategory: 'block',
  },
  ListMcpResources: {
    icon: '\uD83D\uDD0D',
    color: '#7dcfff',
    activity: { verb: 'Listing MCP', pastVerb: 'Listed MCP' },
    inspectorDefault: 'compact',
    renderCategory: 'block',
  },
  'mcp__memory__recall_conversations': RECALL_TOOL_DATA,
  'mcp__crispy__recall': RECALL_TOOL_DATA, // backward compat for old transcripts

  // Deferred tool loading
  ToolSearch: {
    icon: '\uD83D\uDD0D',
    color: '#6272a4',
    activity: { verb: 'Loading tools', pastVerb: 'Loaded tools' },
    inspectorDefault: 'compact',
  },
};

/** Default metadata for unknown tools (MCP, custom) */
const DEFAULT_DATA: ToolDefinitionData = {
  icon: '\uD83D\uDD27',
  color: '#6272a4',
  activity: { verb: 'Running', pastVerb: 'Ran' },
  inspectorDefault: 'compact',
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the full ToolDefinition for a tool by name.
 *
 * Combines static metadata with dynamically registered views.
 * Returns undefined only if no views have been registered.
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  const data = TOOL_DATA[name] ?? getDefaultData(name);
  const views = viewRegistry.get(name) ?? viewRegistry.get('_default');

  if (!views) return undefined;

  return {
    name,
    icon: data.icon,
    color: data.color,
    activity: data.activity,
    inspectorDefault: data.inspectorDefault,
    views: { compact: views.compact, condensed: views.condensed, expanded: views.expanded, inline: views.inline },
  };
}

/**
 * Get static tool data (icon, color, activity) without views.
 */
export function getToolData(name: string): ToolDefinitionData {
  return TOOL_DATA[name] ?? getDefaultData(name);
}

/**
 * Get the render category for a tool in Icon mode.
 * - 'inline': non-destructive → icon pill
 * - 'block': destructive/novel → stays as dot-line/rich view
 * - 'bash': simplified single-line view
 */
export function getToolRenderCategory(
  name: string,
  overrides?: { bashAsBlock?: boolean },
): RenderCategory {
  const data = TOOL_DATA[name];
  if (data) {
    const cat = data.renderCategory ?? 'inline';
    // User pref: promote 'bash' → 'block' so Bash renders as full compact view
    if (cat === 'bash' && overrides?.bashAsBlock) return 'block';
    return cat;
  }
  // MCP tools and skills render as blocks — they're not simple read/search icons
  if (name.startsWith('mcp__') || name.startsWith('mcp_')) return 'block';
  return 'inline';
}

/**
 * Get default data for unknown tools, with MCP prefix detection.
 */
function getDefaultData(name: string): ToolDefinitionData {
  // MCP tools get a special icon
  if (name.startsWith('mcp__')) {
    return {
      icon: '\uD83D\uDD0C',  // 🔌 plug icon for MCP
      color: '#6366f1',
      activity: { verb: 'Running MCP', pastVerb: 'Ran MCP' },
      inspectorDefault: 'compact',
    };
  }
  return DEFAULT_DATA;
}

// ============================================================================
// Subject Extraction — for compact view summaries
// ============================================================================

/**
 * Extract the primary subject from a tool_use block for display in compact view.
 * Returns the most meaningful identifier (file path, command, pattern, etc.)
 */
export function extractSubject(block: RichBlock & { type: 'tool_use' }): string {
  const input = block.input as Record<string, unknown>;

  // File operations: prefer file_path
  if (typeof input.file_path === 'string') {
    return truncatePath(input.file_path);
  }

  // Bash: first line of command
  if (typeof input.command === 'string') {
    const firstLine = input.command.split('\n')[0];
    return truncate(firstLine, 50);
  }

  // Search tools: pattern
  if (typeof input.pattern === 'string') {
    return truncate(input.pattern, 40);
  }

  // Grep/Glob: path if specified
  if (typeof input.path === 'string') {
    return truncatePath(input.path);
  }

  // Task: description or prompt
  if (typeof input.description === 'string') {
    return truncate(input.description, 50);
  }
  if (typeof input.prompt === 'string') {
    const firstLine = input.prompt.split('\n')[0];
    return truncate(firstLine, 50);
  }

  // Web tools: URL
  if (typeof input.url === 'string') {
    return truncate(input.url, 60);
  }
  if (typeof input.query === 'string') {
    return truncate(input.query, 40);
  }

  // Skill: skill name
  if (typeof input.skill === 'string') {
    return input.skill;
  }

  // TaskOutput / TaskStop: task_id
  if (typeof input.task_id === 'string') {
    return input.task_id;
  }

  // EnterWorktree: name
  if (typeof input.name === 'string') {
    return input.name;
  }

  // Fallback: tool name
  return block.name;
}

/**
 * Truncate a string with ellipsis.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Truncate a file path, keeping the filename and parent directory.
 */
function truncatePath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 2) return path;
  const short = parts.slice(-2).join('/');
  return short.length > 60 ? truncate(short, 60) : short;
}
