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
import { BashCompactView, BashExpandedView } from './views/bash-views.js';
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

// ============================================================================
// Register Default Views (fallback for unknown tools)
// ============================================================================

const defaultMeta = getToolData('_unknown');
registerToolViews('_default', {
  ...defaultToolViews(defaultMeta),
  expanded: GenericExpandedView,
});

// ============================================================================
// Register Bash Views
// ============================================================================

const bashMeta = getToolData('Bash');
registerToolViews('Bash', {
  ...defaultToolViews(bashMeta),
  compact: BashCompactView,
  expanded: BashExpandedView,
});

// ============================================================================
// Register Edit Views
// ============================================================================

const editMeta = getToolData('Edit');
registerToolViews('Edit', {
  ...defaultToolViews(editMeta),
  compact: EditCompactView,
  expanded: EditExpandedView,
});

// MultiEdit uses same views as Edit
registerToolViews('MultiEdit', {
  ...defaultToolViews(getToolData('MultiEdit')),
  compact: EditCompactView,
  expanded: EditExpandedView,
});

// ============================================================================
// Register Task Views
// ============================================================================

const taskMeta = getToolData('Task');
registerToolViews('Task', {
  ...defaultToolViews(taskMeta),
  compact: TaskCompactView,
  expanded: TaskExpandedView,
});

// ============================================================================
// Register Read Views
// ============================================================================

const readMeta = getToolData('Read');
registerToolViews('Read', {
  ...defaultToolViews(readMeta),
  compact: ReadCompactView,
  expanded: ReadExpandedView,
});

// ============================================================================
// Register Write Views
// ============================================================================

const writeMeta = getToolData('Write');
registerToolViews('Write', {
  ...defaultToolViews(writeMeta),
  compact: WriteCompactView,
  expanded: WriteExpandedView,
});

// ============================================================================
// Register Search Tool Views
// ============================================================================

const grepMeta = getToolData('Grep');
registerToolViews('Grep', {
  ...defaultToolViews(grepMeta),
  compact: GrepCompactView,
  expanded: GrepExpandedView,
});

const globMeta = getToolData('Glob');
registerToolViews('Glob', {
  ...defaultToolViews(globMeta),
  compact: GlobCompactView,
  expanded: GlobExpandedView,
});

// ============================================================================
// Register TodoWrite Views
// ============================================================================

const todoWriteMeta = getToolData('TodoWrite');
registerToolViews('TodoWrite', {
  ...defaultToolViews(todoWriteMeta),
  compact: TodoWriteCompactView,
  expanded: TodoWriteExpandedView,
});

// ============================================================================
// Register Interaction Tool Views (Skill, AskUserQuestion, ExitPlanMode)
// ============================================================================

const skillMeta = getToolData('Skill');
registerToolViews('Skill', {
  ...defaultToolViews(skillMeta),
  compact: SkillCompactView,
  expanded: SkillExpandedView,
});

const askMeta = getToolData('AskUserQuestion');
registerToolViews('AskUserQuestion', {
  ...defaultToolViews(askMeta),
  compact: AskUserQuestionCompactView,
  expanded: AskUserQuestionExpandedView,
});

const exitPlanMeta = getToolData('ExitPlanMode');
registerToolViews('ExitPlanMode', {
  ...defaultToolViews(exitPlanMeta),
  compact: ExitPlanModeCompactView,
  expanded: ExitPlanModeExpandedView,
});

// ============================================================================
// Register Web Tool Views
// ============================================================================

const webSearchMeta = getToolData('WebSearch');
registerToolViews('WebSearch', {
  ...defaultToolViews(webSearchMeta),
  compact: WebSearchCompactView,
  expanded: WebSearchExpandedView,
});

const webFetchMeta = getToolData('WebFetch');
registerToolViews('WebFetch', {
  ...defaultToolViews(webFetchMeta),
  compact: WebFetchCompactView,
  expanded: WebFetchExpandedView,
});

// ============================================================================
// Register EnterPlanMode Views
// ============================================================================

const enterPlanMeta = getToolData('EnterPlanMode');
registerToolViews('EnterPlanMode', {
  ...defaultToolViews(enterPlanMeta),
  compact: EnterPlanModeCompactView,
  expanded: GenericExpandedView,
});

// ============================================================================
// Register Tools Using Default Views Only
// ============================================================================

// These tools use default compact + generic expanded views
const defaultOnlyTools = [
  'LS',
  'NotebookEdit',
  'TaskOutput',
  'KillShell',
  'ReadMcpResource',
  'ListMcpResources',
];

for (const toolName of defaultOnlyTools) {
  const meta = getToolData(toolName);
  registerToolViews(toolName, {
    ...defaultToolViews(meta),
    expanded: GenericExpandedView,
  });
}

// ============================================================================
// Export flag for import verification
// ============================================================================

export const viewsRegistered = true;
