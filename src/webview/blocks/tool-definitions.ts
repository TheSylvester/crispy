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
  expanded: (props: ToolViewProps) => ReactNode;
}> = new Map();

/**
 * Register views for a tool at runtime.
 * Called by view modules to inject their implementations.
 */
export function registerToolViews(
  name: string,
  views: {
    compact: (props: ToolViewProps) => ReactNode;
    expanded: (props: ToolViewProps) => ReactNode;
  },
): void {
  viewRegistry.set(name, views);
}

// ============================================================================
// Tool Definitions — static metadata + dynamic view lookup
// ============================================================================

interface ToolDefinitionData {
  icon: string;
  color: string;
  activity: { verb: string; pastVerb: string };
  inspectorDefault: 'expanded' | 'compact';
}

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
    color: '#f59e0b',
    activity: { verb: 'Running', pastVerb: 'Ran' },
    inspectorDefault: 'expanded',
  },
  Read: {
    icon: '\uD83D\uDCC4',
    color: '#0ea5e9',
    activity: { verb: 'Reading', pastVerb: 'Read' },
    inspectorDefault: 'compact',
  },
  Write: {
    icon: '\u270E',
    color: '#10b981',
    activity: { verb: 'Writing', pastVerb: 'Wrote' },
    inspectorDefault: 'expanded',
  },
  Edit: {
    icon: '\uD83D\uDCDD',
    color: '#f43f5e',
    activity: { verb: 'Editing', pastVerb: 'Edited' },
    inspectorDefault: 'expanded',
  },
  MultiEdit: {
    icon: '\uD83D\uDCDD',
    color: '#f43f5e',
    activity: { verb: 'Editing', pastVerb: 'Edited' },
    inspectorDefault: 'expanded',
  },
  NotebookEdit: {
    icon: '\uD83D\uDCD3',
    color: '#10b981',
    activity: { verb: 'Editing notebook', pastVerb: 'Edited notebook' },
    inspectorDefault: 'expanded',
  },

  // Search tools
  Glob: {
    icon: '\uD83D\uDCC2',
    color: '#d946ef',
    activity: { verb: 'Searching', pastVerb: 'Found' },
    inspectorDefault: 'compact',
  },
  Grep: {
    icon: '\uD83D\uDD0D',
    color: '#06b6d4',
    activity: { verb: 'Searching', pastVerb: 'Searched' },
    inspectorDefault: 'compact',
  },
  LS: {
    icon: '\uD83D\uDD0D',
    color: '#06b6d4',
    activity: { verb: 'Listing', pastVerb: 'Listed' },
    inspectorDefault: 'compact',
  },

  // Web tools
  WebSearch: {
    icon: '\uD83C\uDF10',
    color: '#8b5cf6',
    activity: { verb: 'Searching', pastVerb: 'Searched' },
    inspectorDefault: 'compact',
  },
  WebFetch: {
    icon: '\uD83C\uDF0E',
    color: '#6366f1',
    activity: { verb: 'Fetching', pastVerb: 'Fetched' },
    inspectorDefault: 'compact',
  },

  // Agent tools
  Task: {
    icon: '\uD83E\uDD16',
    color: '#64748b',
    activity: { verb: 'Running agent', pastVerb: 'Agent completed' },
    inspectorDefault: 'expanded',
  },
  Agent: {
    icon: '\uD83E\uDD16',
    color: '#64748b',
    activity: { verb: 'Running agent', pastVerb: 'Agent completed' },
    inspectorDefault: 'expanded',
  },
  TaskOutput: {
    icon: '\uD83E\uDD16',
    color: '#64748b',
    activity: { verb: 'Getting output', pastVerb: 'Got output' },
    inspectorDefault: 'expanded',
  },
  KillShell: {
    icon: '\uD83E\uDD16',
    color: '#64748b',
    activity: { verb: 'Killing shell', pastVerb: 'Killed shell' },
    inspectorDefault: 'expanded',
  },
  TaskStop: {
    icon: '\uD83D\uDED1',
    color: '#ef4444',
    activity: { verb: 'Stopping task', pastVerb: 'Stopped task' },
    inspectorDefault: 'compact',
  },

  // Utility tools
  TodoWrite: {
    icon: '\u2611\uFE0F',
    color: '#8b5cf6',
    activity: { verb: 'Updating todos', pastVerb: 'Updated todos' },
    inspectorDefault: 'expanded',
  },
  Skill: {
    icon: '\u2728',
    color: '#7c3aed',
    activity: { verb: 'Running skill', pastVerb: 'Ran skill' },
    inspectorDefault: 'expanded',
  },

  // User interaction tools
  AskUserQuestion: {
    icon: '\u2753',
    color: '#14b8a6',
    activity: { verb: 'Asking', pastVerb: 'Asked' },
    inspectorDefault: 'expanded',
  },
  ExitPlanMode: {
    icon: '\uD83D\uDCCB',
    color: '#3b82f6',
    activity: { verb: 'Exiting plan mode', pastVerb: 'Exited plan mode' },
    inspectorDefault: 'expanded',
  },
  EnterPlanMode: {
    icon: '\uD83D\uDCCB',
    color: '#3b82f6',
    activity: { verb: 'Entering plan mode', pastVerb: 'Entered plan mode' },
    inspectorDefault: 'expanded',
  },
  EnterWorktree: {
    icon: '\uD83C\uDF33',
    color: '#22c55e',
    activity: { verb: 'Creating worktree', pastVerb: 'Created worktree' },
    inspectorDefault: 'compact',
  },

  // MCP tools
  ReadMcpResource: {
    icon: '\uD83D\uDCC4',
    color: '#0ea5e9',
    activity: { verb: 'Reading MCP', pastVerb: 'Read MCP' },
    inspectorDefault: 'compact',
  },
  ListMcpResources: {
    icon: '\uD83D\uDD0D',
    color: '#06b6d4',
    activity: { verb: 'Listing MCP', pastVerb: 'Listed MCP' },
    inspectorDefault: 'compact',
  },
};

/** Default metadata for unknown tools (MCP, custom) */
const DEFAULT_DATA: ToolDefinitionData = {
  icon: '\uD83D\uDD27',
  color: '#4b5563',
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
    views: { compact: views.compact, expanded: views.expanded },
  };
}

/**
 * Get static tool data (icon, color, activity) without views.
 */
export function getToolData(name: string): ToolDefinitionData {
  return TOOL_DATA[name] ?? getDefaultData(name);
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
