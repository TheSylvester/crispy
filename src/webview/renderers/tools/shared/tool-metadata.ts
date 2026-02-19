/**
 * Single source of truth for per-tool display metadata.
 * Consolidates 6 previously independent maps:
 *  - TOOL_ICON_MAP (ActivityGroup.tsx)
 *  - TOOL_BADGE_COLOR (ActivityGroup.tsx)
 *  - ACTIVITY_BADGE_COLOR (ActivityGroup.tsx)
 *  - TOOL_ACTIVITY_MAP (tool-registry.ts)
 *  - SAFE_TOOLS (coalesce-entries.ts)
 *  - Hardcoded icon/badgeColor in each tool renderer
 *
 * @module webview/renderers/tools/shared/tool-metadata
 */

export type ToolActivity = 'read' | 'search' | 'fetch' | 'execute' | 'track' | 'invoke';

export interface ToolMeta {
  /** Emoji icon displayed in tool card header and activity groups */
  icon: string;
  /** Hex color for the tool badge */
  badgeColor: string;
  /** Activity classification for coalescing and grouping */
  activity?: ToolActivity;
  /** Whether this tool can be coalesced into ActivityGroups */
  safe?: boolean;
}

/**
 * Per-tool display metadata.
 *
 * IMPORTANT: When adding a new tool, add it here. This is the ONLY place
 * tool display metadata should be defined. Do NOT add hardcoded icon or
 * badgeColor values in individual tool renderer files.
 *
 * Icons are Unicode escapes matching actual tool renderer values:
 *   \uD83D\uDCBB = 💻  \uD83D\uDCC4 = 📄  \uD83D\uDCDD = 📝
 *   \uD83D\uDCC2 = 📂  \uD83D\uDD0D = 🔍  \uD83E\uDD16 = 🤖
 *   \uD83C\uDF10 = 🌐  \uD83C\uDF0E = 🌎  \uD83D\uDCCB = 📋
 *   \uD83D\uDD27 = 🔧  \uD83D\uDCD3 = 📓  \u270E = ✎
 *   \u2611 = ☑        \u2728 = ✨        \u2753 = ❓
 */
export const TOOL_META: Record<string, ToolMeta> = {
  // Core file operations
  Bash:             { icon: '\uD83D\uDCBB', badgeColor: '#f59e0b', activity: 'execute' },
  Read:             { icon: '\uD83D\uDCC4', badgeColor: '#0ea5e9', activity: 'read',   safe: true },
  Write:            { icon: '\u270E',       badgeColor: '#10b981' },
  Edit:             { icon: '\uD83D\uDCDD', badgeColor: '#f43f5e' },
  MultiEdit:        { icon: '\uD83D\uDCDD', badgeColor: '#f43f5e' },
  NotebookEdit:     { icon: '\uD83D\uDCD3', badgeColor: '#10b981' },

  // Search tools
  Glob:             { icon: '\uD83D\uDCC2', badgeColor: '#d946ef', activity: 'search', safe: true },
  Grep:             { icon: '\uD83D\uDD0D', badgeColor: '#06b6d4', activity: 'search', safe: true },
  LS:               { icon: '\uD83D\uDD0D', badgeColor: '#06b6d4', activity: 'search' },

  // Web tools
  WebSearch:        { icon: '\uD83C\uDF10', badgeColor: '#8b5cf6', activity: 'search', safe: true },
  WebFetch:         { icon: '\uD83C\uDF0E', badgeColor: '#6366f1', activity: 'fetch',  safe: true },

  // Agent tools
  Task:             { icon: '\uD83E\uDD16', badgeColor: '#64748b' },
  TaskOutput:       { icon: '\uD83E\uDD16', badgeColor: '#64748b' },
  KillShell:        { icon: '\uD83E\uDD16', badgeColor: '#64748b' },

  // Utility tools
  TodoWrite:        { icon: '\u2611',       badgeColor: '#8b5cf6', activity: 'track',  safe: true },
  Skill:            { icon: '\u2728',       badgeColor: '#7c3aed', activity: 'invoke', safe: true },

  // User interaction tools
  AskUserQuestion:  { icon: '\u2753',       badgeColor: '#14b8a6' },
  ExitPlanMode:     { icon: '\uD83D\uDCCB', badgeColor: '#3b82f6' },
  EnterPlanMode:    { icon: '\uD83D\uDCCB', badgeColor: '#3b82f6' },

  // MCP tools
  ReadMcpResource:  { icon: '\uD83D\uDCC4', badgeColor: '#0ea5e9', activity: 'read' },
  ListMcpResources: { icon: '\uD83D\uDD0D', badgeColor: '#06b6d4', activity: 'search' },
};

export const DEFAULT_META: ToolMeta = {
  icon: '\uD83D\uDD27',
  badgeColor: '#4b5563',
};

/** Get display metadata for a tool by name, with fallback defaults */
export function getToolMeta(toolName: string): ToolMeta {
  return TOOL_META[toolName] ?? DEFAULT_META;
}

/** Badge colors keyed by activity type, for activity group chips */
export const ACTIVITY_BADGE_COLOR: Record<ToolActivity, string> = {
  read:    '#0ea5e9',
  search:  '#8b5cf6',
  fetch:   '#6366f1',
  execute: '#f59e0b',
  track:   '#8b5cf6',
  invoke:  '#7c3aed',
};
