/**
 * Register Views — side-effect module that wires tool views to definitions
 *
 * Import this module once at app startup to register all tool views
 * with the tool definition registry.
 *
 * This avoids circular dependencies by keeping view implementations
 * separate from static tool metadata.
 *
 * @module webview/blocks/register-views
 */

import { registerToolViews, getToolData } from './tool-definitions.js';
import { defaultToolViews, GenericExpandedView } from './views/default-views.js';
import { DefaultInlineView } from './views/inline-view.js';
import { BashCompactView, BashCondensedView, BashExpandedView } from './views/bash-views.js';
import { EditCompactView, EditExpandedView } from './views/edit-views.js';
import { TaskCompactView, TaskExpandedView } from './views/task-views.js';
import { ReadCompactView, ReadExpandedView } from './views/read-views.js';
import { WriteCompactView, WriteExpandedView } from './views/write-views.js';
import { GrepCompactView, GrepExpandedView } from './views/grep-views.js';
import { GlobCompactView, GlobExpandedView } from './views/glob-views.js';
import { TodoWriteCompactView, TodoWriteExpandedView } from './views/todowrite-views.js';
import { SkillCompactView, SkillExpandedView } from './views/skill-views.js';
import { AskUserQuestionCompactView, AskUserQuestionExpandedView } from './views/askuserquestion-views.js';
import { ExitPlanModeCompactView, ExitPlanModeExpandedView } from './views/exitplanmode-views.js';
import { WebSearchCompactView, WebSearchExpandedView } from './views/websearch-views.js';
import { WebFetchCompactView, WebFetchExpandedView } from './views/webfetch-views.js';
import { EnterPlanModeCompactView } from './views/enterplanmode-views.js';
import { TaskOutputCompactView, TaskOutputExpandedView } from './views/taskoutput-views.js';
import { ChromeCompactView, ChromeExpandedView } from './views/chrome-views.js';
import { RecallCompactView, RecallExpandedView } from './views/recall-views.js';
import { ReadConversationCompactView, ReadConversationExpandedView } from './views/read-conversation-views.js';
import { ToolSearchCompactView, ToolSearchExpandedView } from './views/toolsearch-views.js';

// ============================================================================
// Register Default Views (fallback for unknown tools)
// ============================================================================

const defaultMeta = getToolData('_unknown');
registerToolViews('_default', {
  ...defaultToolViews(defaultMeta),
  expanded: GenericExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Bash Views
// ============================================================================

registerToolViews('Bash', {
  compact: BashCompactView,
  condensed: BashCondensedView,
  expanded: BashExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Edit Views
// ============================================================================

registerToolViews('Edit', {
  compact: EditCompactView,
  expanded: EditExpandedView,
  inline: DefaultInlineView,
});

// MultiEdit uses same views as Edit
registerToolViews('MultiEdit', {
  compact: EditCompactView,
  expanded: EditExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Task Views — NO inline (they have children)
// ============================================================================

registerToolViews('Task', {
  compact: TaskCompactView,
  expanded: TaskExpandedView,
  // No inline — Task/Agent are exempt (they have children)
});

// Agent uses same views as Task (renamed in Claude Code 2.1.63+)
registerToolViews('Agent', {
  compact: TaskCompactView,
  expanded: TaskExpandedView,
  // No inline — Task/Agent are exempt (they have children)
});

// ============================================================================
// Register TaskOutput Views
// ============================================================================

registerToolViews('TaskOutput', {
  compact: TaskOutputCompactView,
  expanded: TaskOutputExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Read Views
// ============================================================================

registerToolViews('Read', {
  compact: ReadCompactView,
  expanded: ReadExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Write Views
// ============================================================================

registerToolViews('Write', {
  compact: WriteCompactView,
  expanded: WriteExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Search Tool Views
// ============================================================================

registerToolViews('Grep', {
  compact: GrepCompactView,
  expanded: GrepExpandedView,
  inline: DefaultInlineView,
});

registerToolViews('Glob', {
  compact: GlobCompactView,
  expanded: GlobExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register TodoWrite Views
// ============================================================================

registerToolViews('TodoWrite', {
  compact: TodoWriteCompactView,
  expanded: TodoWriteExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Interaction Tool Views (Skill, AskUserQuestion, ExitPlanMode)
// ============================================================================

registerToolViews('Skill', {
  compact: SkillCompactView,
  expanded: SkillExpandedView,
  inline: DefaultInlineView,
});

registerToolViews('AskUserQuestion', {
  compact: AskUserQuestionCompactView,
  expanded: AskUserQuestionExpandedView,
  inline: DefaultInlineView,
});

registerToolViews('ExitPlanMode', {
  compact: ExitPlanModeCompactView,
  expanded: ExitPlanModeExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Web Tool Views
// ============================================================================

registerToolViews('WebSearch', {
  compact: WebSearchCompactView,
  expanded: WebSearchExpandedView,
  inline: DefaultInlineView,
});

registerToolViews('WebFetch', {
  compact: WebFetchCompactView,
  expanded: WebFetchExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Chrome MCP Tool Views
// ============================================================================

const CHROME_TOOL_NAMES = [
  'mcp__claude-in-chrome__computer',
  'mcp__claude-in-chrome__find',
  'mcp__claude-in-chrome__navigate',
  'mcp__claude-in-chrome__read_page',
  'mcp__claude-in-chrome__javascript_tool',
  'mcp__claude-in-chrome__tabs_context_mcp',
  'mcp__claude-in-chrome__tabs_create_mcp',
  'mcp__claude-in-chrome__form_input',
  'mcp__claude-in-chrome__resize_window',
  'mcp__claude-in-chrome__read_console_messages',
  'mcp__claude-in-chrome__read_network_requests',
  'mcp__claude-in-chrome__gif_creator',
  'mcp__claude-in-chrome__get_page_text',
  'mcp__claude-in-chrome__upload_image',
  'mcp__claude-in-chrome__update_plan',
  'mcp__claude-in-chrome__shortcuts_list',
  'mcp__claude-in-chrome__shortcuts_execute',
];

for (const toolName of CHROME_TOOL_NAMES) {
  registerToolViews(toolName, {
    compact: ChromeCompactView,
    expanded: ChromeExpandedView,
    inline: DefaultInlineView,
  });
}

// ============================================================================
// Register Recall MCP Views (canonical + backward-compat alias)
// ============================================================================

for (const name of ['mcp__memory__recall_conversations', 'mcp__crispy__recall']) {
  registerToolViews(name, {
    compact: RecallCompactView,
    expanded: RecallExpandedView,
    inline: DefaultInlineView,
  });
}

// ============================================================================
// Register Read Conversation MCP Views
// ============================================================================

registerToolViews('mcp__memory__read_conversation', {
  compact: ReadConversationCompactView,
  expanded: ReadConversationExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register ToolSearch Views
// ============================================================================

registerToolViews('ToolSearch', {
  compact: ToolSearchCompactView,
  expanded: ToolSearchExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register EnterPlanMode Views
// ============================================================================

registerToolViews('EnterPlanMode', {
  compact: EnterPlanModeCompactView,
  expanded: GenericExpandedView,
  inline: DefaultInlineView,
});

// ============================================================================
// Register Tools Using Default Views Only
// ============================================================================

// These tools use default compact + generic expanded views
const defaultOnlyTools = [
  'LS',
  'NotebookEdit',
  'KillShell',
  'TaskStop',
  'EnterWorktree',
  'ReadMcpResource',
  'ListMcpResources',
];

for (const toolName of defaultOnlyTools) {
  const meta = getToolData(toolName);
  registerToolViews(toolName, {
    ...defaultToolViews(meta),
    expanded: GenericExpandedView,
    inline: DefaultInlineView,
  });
}

// ============================================================================
// Export flag for import verification
// ============================================================================

export const viewsRegistered = true;
