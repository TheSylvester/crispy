/**
 * Views Module — exports all tool views and registers them with tool-definitions
 *
 * Importing this module has the side effect of registering all tool views
 * with the tool definition registry.
 *
 * @module webview/blocks/views
 */

export { defaultToolViews, GenericExpandedView } from './default-views.js';
export { BashCompactView, BashExpandedView } from './bash-views.js';
export { EditCompactView, EditExpandedView } from './edit-views.js';
export { TaskCompactView, TaskExpandedView } from './task-views.js';
export { ReadExpandedView } from './read-views.js';
export { WriteExpandedView } from './write-views.js';
export { GrepExpandedView } from './grep-views.js';
export { GlobExpandedView } from './glob-views.js';

// Re-export the registration function for use in register-views
export { registerToolViews } from '../tool-definitions.js';
