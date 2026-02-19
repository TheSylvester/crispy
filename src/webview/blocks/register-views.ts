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
import { ReadExpandedView } from './views/read-views.js';
import { WriteExpandedView } from './views/write-views.js';
import { GrepExpandedView } from './views/grep-views.js';
import { GlobExpandedView } from './views/glob-views.js';

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
  expanded: ReadExpandedView,
});

// ============================================================================
// Register Write Views
// ============================================================================

const writeMeta = getToolData('Write');
registerToolViews('Write', {
  ...defaultToolViews(writeMeta),
  expanded: WriteExpandedView,
});

// ============================================================================
// Register Search Tool Views
// ============================================================================

const grepMeta = getToolData('Grep');
registerToolViews('Grep', {
  ...defaultToolViews(grepMeta),
  expanded: GrepExpandedView,
});

const globMeta = getToolData('Glob');
registerToolViews('Glob', {
  ...defaultToolViews(globMeta),
  expanded: GlobExpandedView,
});

// ============================================================================
// Register Tools Using Default Views Only
// ============================================================================

// These tools use default collapsed + compact + generic expanded views
const defaultOnlyTools = [
  'LS',
  'NotebookEdit',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'Skill',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
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
